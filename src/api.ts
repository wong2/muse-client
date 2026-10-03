import { MuseError, MuseHttpError, MuseProtocolError } from './errors.js';

export interface DeviceCredentials {
  accessToken: string;
  refreshToken: string;
  /** The node_id used during pairing, e.g. homelink-123abc. */
  deviceId: string;
  sdkToken?: string;
  apiUrl?: string;
  noiseHost?: string;
  savedAt?: number;
}
export interface MuseVM {
  id: string;
  name: string;
  url: string;
  authToken: string;
  isDefault: boolean;
}
export interface AccountOptions {
  credentials: DeviceCredentials;
  /** Must durably save rotated tokens before resolving. */
  onCredentials?: (credentials: DeviceCredentials) => Promise<void> | void;
  fetch?: typeof globalThis.fetch;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MuseProtocolError('Expected JSON object');
  return value as Record<string, unknown>;
}
export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new MuseProtocolError(`Missing ${label}`);
  return value;
}

export class MuseAccount {
  private current: DeviceCredentials;
  private refreshing?: Promise<DeviceCredentials>;
  constructor(private readonly options: AccountOptions) {
    this.current = { ...options.credentials };
    requiredString(this.current.accessToken, 'access token');
    requiredString(this.current.deviceId, 'device ID');
  }
  get credentials(): DeviceCredentials { return { ...this.current }; }
  private async call(path: string, token: string, body?: unknown): Promise<unknown> {
    const root = new URL(this.current.apiUrl || 'https://api.muse.ai');
    if (root.protocol !== 'https:' || root.username || root.password) throw new MuseError('Muse API requires HTTPS');
    const response = await (this.options.fetch ?? globalThis.fetch)(new URL(path, root), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-API-Version': '1.0.0',
        'User-Agent': 'muse-client/0.1.0', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    if (!response.ok) throw new MuseHttpError(response.status, path);
    return response.json();
  }
  refresh(): Promise<DeviceCredentials> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.rotate().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async rotate(): Promise<DeviceCredentials> {
    const raw = requiredString(this.current.refreshToken, 'refresh token').split(':').at(-1)!;
    const result = object(await this.call('/device_token/refresh', `hatch_refresh:${raw}`, {
      device_id: this.current.deviceId,
      ...(this.current.sdkToken ? { sdk_token: this.current.sdkToken } : {}),
    }));
    const data = object(result.payload ?? result);
    const next = { ...this.current,
      accessToken: requiredString(data.access_token, 'refreshed access token'),
      refreshToken: requiredString(data.refresh_token, 'refreshed refresh token'),
      savedAt: Math.floor(Date.now() / 1000),
    };
    // Keep rotated tokens in memory even if disk persistence fails.
    this.current = next;
    await this.options.onCredentials?.({ ...next });
    return { ...next };
  }
  async listVMs(): Promise<MuseVM[]> {
    if (this.current.savedAt && Date.now() / 1000 - this.current.savedAt >= 10800 && this.current.refreshToken) {
      await this.refresh();
    }
    let result: unknown;
    try { result = await this.call('/fetch_vms', this.current.accessToken); }
    catch (error) {
      if (!(error instanceof MuseHttpError) || error.status !== 401 || !this.current.refreshToken) throw error;
      await this.refresh();
      result = await this.call('/fetch_vms', this.current.accessToken);
    }
    const data = object(result);
    if (!Array.isArray(data.vm_list)) throw new MuseProtocolError('Muse response is missing vm_list');
    return data.vm_list.map((entry: unknown) => {
      const vm = object(entry);
      return {
        id: requiredString(vm.vm_id, 'VM ID'), name: typeof vm.vm_name === 'string' ? vm.vm_name : '',
        url: requiredString(vm.vm_ws_url ?? vm.vm_url, 'VM URL'),
        authToken: requiredString(vm.vm_auth_token, 'VM token'), isDefault: vm.default === true,
      };
    });
  }
}
