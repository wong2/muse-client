import { object, requiredString } from '../api.js';
import type { DeviceCredentials } from '../api.js';
import { MuseProtocolError } from '../errors.js';
import { PairingSession, PacketAssembler, encodePackets } from './protocol.js';

interface ControllerOptions {
  session: PairingSession;
  sdkToken?: string;
  probe?: boolean;
  online: boolean;
  send: (packets: Buffer[]) => void;
  progress: (message: string) => void;
  verify: (credentials: DeviceCredentials) => Promise<void>;
  /** Synchronous commit: no disconnect/hello can race the final credential write. */
  save: (credentials: DeviceCredentials) => void;
  complete: (credentials?: DeviceCredentials) => void;
  failed: (error: Error) => void;
}

export class PairingController {
  private readonly assembler = new PacketAssembler();
  private generation = 0;
  private stopped = false;
  private encryptedOnly = false;
  private provisioning = false;
  constructor(private readonly options: ControllerOptions) {}
  disconnect(): void {
    this.generation++; this.stopped = true;
    this.options.session.reset(); this.assembler.reset();
  }
  private send(value: unknown): void {
    this.options.send(encodePackets(Buffer.from(JSON.stringify(value))));
  }
  private status(status: string): void {
    this.send(this.options.session.encrypt({ type: 'status', status,
      ...(status === 'pairing_confirmed' && this.options.sdkToken ? { sdk_token: this.options.sdkToken } : {}) }));
  }
  async receive(packet: Buffer): Promise<void> {
    if (this.stopped) return;
    try {
      const raw = this.assembler.feed(packet);
      if (!raw) return;
      let command = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
      const session = this.options.session;
      let encrypted = false;
      if (command.action === 'pairing_encrypted') {
        command = session.decrypt(command); encrypted = true;
      }
      const action = command.action;
      // Public metadata is allowed even after an encrypted session starts.
      if (action === 'get_device_info') {
        this.options.progress('Phone requested device information.');
        this.send({ type: 'device_info', ...session.info(), node_id: session.identity.nodeId,
          version: session.version, build_sha: '', network_ready: this.options.online });
        return;
      }
      if (this.options.probe) {
        this.options.progress('Discovery probe reached authorization; stopping without accepting credentials.');
        this.options.complete(); this.disconnect(); return;
      }
      if (!encrypted && action === 'pairing_client_hello') {
        this.generation++; this.provisioning = false;
        this.send(session.hello(command)); this.encryptedOnly = true;
        this.options.progress('Encrypted pairing handshake started.'); return;
      }
      if (!encrypted) {
        if (!this.encryptedOnly) this.options.send([Buffer.from('error_encryption_required')]);
        return;
      }
      if (action === 'pairing_client_finished') {
        session.confirm(command); this.status('pairing_confirmed');
        this.options.progress('App consent received; waiting for device credentials.'); return;
      }
      session.assertConfirmed();
      if (action === 'wifi_scan') {
        this.send(session.encrypt({ type: 'wifi_scan_result', networks: this.options.online
          ? [{ ssid: 'Use current connection', rssi: -40, secure: false }] : [] }));
        return;
      }
      if (action !== 'provision_v2') { this.status('error_unknown_action'); return; }
      if (this.provisioning) { this.status('error_operation_in_progress'); return; }
      if (command.token_type !== 'device' || typeof command.ssid !== 'string' || typeof command.password !== 'string'
        || typeof command.access_token !== 'string' || !command.access_token || typeof command.refresh_token !== 'string' || !command.refresh_token) {
        this.status('error_missing_credentials'); return;
      }
      session.provision(); this.provisioning = true;
      const generation = this.generation;
      const credentials: DeviceCredentials = {
        accessToken: requiredString(command.access_token, 'device access token'),
        refreshToken: requiredString(command.refresh_token, 'device refresh token'),
        deviceId: session.identity.nodeId, sdkToken: this.options.sdkToken,
        apiUrl: typeof command.api_url_v2 === 'string' ? command.api_url_v2 || undefined : undefined,
        noiseHost: typeof command.noise_host === 'string' ? command.noise_host || undefined : undefined,
        savedAt: Math.floor(Date.now() / 1000),
      };
      this.status('wifi_connecting');
      if (!this.options.online) { this.status('wifi_failed'); this.provisioning = false; return; }
      this.status('wifi_connected');
      try {
        await this.options.verify(credentials);
      } catch {
        if (this.stopped || generation !== this.generation) return;
        this.status('auth_failed'); throw new MuseProtocolError('Muse rejected the provisioned credentials or could not be reached');
      }
      if (this.stopped || generation !== this.generation) return;
      session.assertConfirmed();
      try { this.options.save(credentials); }
      catch { this.status('error_storage'); throw new MuseProtocolError('Could not save pairing credentials'); }
      this.options.progress('Device credentials verified and saved.');
      this.status('auth_ok');
      this.options.complete(credentials);
      this.disconnect();
    } catch (error) {
      if (this.stopped) return;
      this.disconnect();
      this.options.failed(error instanceof MuseProtocolError ? error : new MuseProtocolError('Invalid pairing message'));
    }
  }
}
