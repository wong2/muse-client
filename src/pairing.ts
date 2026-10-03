import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, access, copyFile, mkdtemp, rename, rm } from 'node:fs/promises';
import { existsSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connect as connectTCP } from 'node:net';
import { MuseAccount, object, requiredString } from './api.js';
import type { DeviceCredentials } from './api.js';
import { MuseError } from './errors.js';
import { defaultCredentialsDirectory } from './credentials.js';
import { PairingController } from './pairing/controller.js';
import { identityFromMac, newIdentity, PairingSession } from './pairing/protocol.js';

const exec = promisify(execFile);
const nativeDirectory = fileURLToPath(new URL('../native/macos/', import.meta.url));

export interface PairMacOSOptions {
  directory?: string;
  /** Omit to read the directory's sdk_token file. Never pass secrets on a command line. */
  sdkToken?: string;
  /** Discovery only: stop before authorization and return undefined. */
  probe?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export function validateSDKToken(token: string): string {
  const value = token.trim();
  if (!/^mgst_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)) throw new MuseError('Invalid SDK token format');
  return value;
}

/** Build and cache the native macOS Bluetooth transport helper. */
export async function buildPairingHelper(onProgress: (message: string) => void = () => {}): Promise<string> {
  if (process.platform !== 'darwin') throw new MuseError('Bluetooth pairing currently supports macOS only');
  const [source, plist] = await Promise.all([
    readFile(join(nativeDirectory, 'PairingHelper.swift')), readFile(join(nativeDirectory, 'Info.plist')),
  ]);
  const digest = createHash('sha256').update(source).update(plist).update(process.arch).digest('hex').slice(0, 20);
  const cache = join(homedir(), 'Library', 'Caches', 'muse-client', 'bluetooth');
  const destination = join(cache, digest);
  const executable = join(destination, 'Muse Pair.app', 'Contents', 'MacOS', 'MusePair');
  try { await access(executable); return executable; } catch {}
  onProgress('Compiling the macOS Bluetooth helper (requires Xcode Command Line Tools)…');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(cache, 'build-'));
  const app = join(temporary, 'Muse Pair.app');
  try {
    await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
    await exec('xcrun', ['swiftc', '-swift-version', '5', join(nativeDirectory, 'PairingHelper.swift'),
      '-o', join(app, 'Contents', 'MacOS', 'MusePair'), '-framework', 'AppKit', '-framework', 'CoreBluetooth'], { timeout: 60000 });
    await copyFile(join(nativeDirectory, 'Info.plist'), join(app, 'Contents', 'Info.plist'));
    await exec('codesign', ['--force', '--sign', '-', app], { timeout: 15000 });
    try { await rename(temporary, destination); }
    catch (error) {
      // Another caller may have completed the same source-hash build.
      if (!existsSync(executable)) throw error;
    }
    return executable;
  } catch {
    throw new MuseError('Could not compile the Bluetooth helper. Install Xcode Command Line Tools with xcode-select --install.');
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function writePrivate(path: string, data: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

async function online(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectTCP({ host: 'api.muse.ai', port: 443 });
    const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(5000, () => finish(false));
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}

/** Pair a software gadget through the official phone app. Existing pairings are preserved. */
export async function pairMacOS(options: PairMacOSOptions = {}): Promise<DeviceCredentials | undefined> {
  if (process.platform !== 'darwin') throw new MuseError('Bluetooth pairing currently supports macOS only');
  options.signal?.throwIfAborted();
  const directory = resolve(options.directory ?? defaultCredentialsDirectory());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!options.probe && existsSync(join(directory, 'pairing.json'))) {
    throw new MuseError('Already paired. Run cli chat, or choose a different --credentials directory for a new gadget.');
  }
  let sdkToken: string | undefined;
  if (!options.probe) {
    sdkToken = validateSDKToken(options.sdkToken ?? await readFile(join(directory, 'sdk_token'), 'utf8'));
  }
  // A lock also prevents two helpers from writing the same device identity.
  const lockPath = join(directory, 'pair.lock');
  let lock: number;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch { throw new MuseError(`Pairing directory is locked. Stop any pairing process first; if none is running, remove ${lockPath}.`); }
  try {
    writeFileSync(lock, String(process.pid));
    let identity;
    try { identity = identityFromMac(requiredString(object(JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'))).mac, 'identity MAC')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      identity = newIdentity(); writePrivate(join(directory, 'identity.json'), JSON.stringify({ mac: identity.mac }, null, 2));
    }
    if (sdkToken) writePrivate(join(directory, 'sdk_token'), sdkToken + '\n');
    const progress = options.onProgress ?? (() => {});
    const executable = await buildPairingHelper(progress);
    options.signal?.throwIfAborted();
    const networkReady = await online();
    if (!networkReady && !options.probe) throw new MuseError('Cannot reach Muse. Connect this Mac to the internet and retry.');
    options.signal?.throwIfAborted();
    progress(`Device: ${identity.name}. Open Muse > Settings > Devices > Add Device (Developer mode enabled).`);
    return await new Promise<DeviceCredentials | undefined>((resolveResult, reject) => {
      const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      let finished = false, completed = false;
      let credentials: DeviceCredentials | undefined;
      let buffer = '';
      const send = (event: unknown) => {
        if (!finished && !child.stdin.destroyed) child.stdin.write(JSON.stringify(event) + '\n');
      };
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true; controller.disconnect(); clearTimeout(timer);
        options.signal?.removeEventListener('abort', aborted);
        child.stdin.end(); child.kill();
        if (error) reject(error); else resolveResult(credentials);
      };
      const aborted = () => finish(new MuseError('Pairing cancelled'));
      const timer = setTimeout(() => finish(new MuseError('Pairing timed out after ten minutes')), 600000);
      const controller = new PairingController({
        session: new PairingSession(identity), sdkToken, probe: options.probe, online: networkReady,
        send: (packets) => send({ event: 'packets', packets: packets.map((p) => p.toString('base64')) }),
        progress,
        verify: async (value) => {
          // Verify exactly the supplied access token; don't rotate during provisioning.
          const vms = await new MuseAccount({ credentials: { ...value, refreshToken: '' } }).listVMs();
          if (!vms.length) throw new MuseError('No Muse VM available');
        },
        save: (value) => {
          if (existsSync(join(directory, 'pairing.json'))) throw new MuseError('Pairing already exists');
          writePrivate(join(directory, 'pairing.json'), JSON.stringify({ access_token: value.accessToken,
            refresh_token: value.refreshToken, token_type: 'device', api_url_v2: value.apiUrl ?? '',
            noise_host: value.noiseHost ?? '', access_token_saved_at: value.savedAt }, null, 2));
        },
        complete: (value) => { completed = true; credentials = value; send({ event: 'complete' }); },
        failed: (error) => finish(error),
      });
      options.signal?.addEventListener('abort', aborted, { once: true });
      if (options.signal?.aborted) { aborted(); return; }
      child.stdin.on('error', () => finish(new MuseError('Bluetooth helper input closed')));
      // Drain system diagnostics, never forward raw IPC or credential material.
      child.stderr.resume();
      child.on('error', () => finish(new MuseError('Could not start Bluetooth helper')));
      child.on('close', () => finish(completed ? undefined : new MuseError('Bluetooth helper closed before pairing completed')));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (data: string) => {
        if (finished) return;
        buffer += data;
        if (buffer.length > 262144) { finish(new MuseError('Bluetooth helper output exceeded size limit')); return; }
        let offset: number;
        while ((offset = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, offset); buffer = buffer.slice(offset + 1);
          try {
            const event = object(JSON.parse(line));
            switch (event.event) {
              case 'ready': send({ event: 'start', name: identity.name }); break;
              case 'advertising': progress(`Advertising ${identity.name}; waiting for the phone.`); break;
              case 'subscribed': progress('Phone connected.'); break;
              case 'bluetooth':
                if (event.state === 4) progress('Bluetooth is off. Turn it on in System Settings.');
                break;
              case 'write':
                void controller.receive(Buffer.from(requiredString(event.data, 'BLE packet'), 'base64'));
                break;
              case 'disconnected':
                if (!completed) finish(new MuseError('Phone disconnected. Run cli pair to retry.'));
                break;
              case 'error': finish(new MuseError(requiredString(event.message, 'helper error'))); break;
              // Resolve on process close, after pending notifications have drained.
              case 'stopped': break;
            }
          } catch { finish(new MuseError('Invalid Bluetooth helper message')); }
        }
      });
    });
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
