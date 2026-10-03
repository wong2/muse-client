import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { object, requiredString } from './api.js';
import type { DeviceCredentials } from './api.js';

export function defaultCredentialsDirectory(): string {
  return process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'MuseGadgetPair')
    : '/var/lib/musegadget';
}

/** Reads the pairing files from the original gadget SDK / macOS experiment. */
export async function loadCredentials(directory = defaultCredentialsDirectory()): Promise<DeviceCredentials> {
  const [pairing, identity] = await Promise.all([
    readFile(join(directory, 'pairing.json'), 'utf8').then((s) => object(JSON.parse(s))),
    readFile(join(directory, 'identity.json'), 'utf8').then((s) => object(JSON.parse(s))),
  ]);
  const mac = requiredString(identity.mac, 'paired identity MAC');
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac)) throw new Error('Invalid paired identity MAC');
  let sdkToken: string | undefined;
  try { sdkToken = (await readFile(join(directory, 'sdk_token'), 'utf8')).trim() || undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return {
    accessToken: requiredString(pairing.access_token, 'device access token'),
    refreshToken: requiredString(pairing.refresh_token, 'device refresh token'),
    deviceId: `homelink-${mac.replaceAll(':', '').slice(-6)}`, sdkToken,
    apiUrl: typeof pairing.api_url_v2 === 'string' ? pairing.api_url_v2 || undefined : undefined,
    noiseHost: typeof pairing.noise_host === 'string' ? pairing.noise_host || undefined : undefined,
    savedAt: typeof pairing.access_token_saved_at === 'number' ? pairing.access_token_saved_at : undefined,
  };
}

/** Atomically updates the original pairing file; never logs tokens. */
export async function saveCredentials(credentials: DeviceCredentials, directory = defaultCredentialsDirectory()): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'pairing.json');
  let previous: Record<string, unknown> = {};
  try { previous = object(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const data = { ...previous, access_token: credentials.accessToken, refresh_token: credentials.refreshToken,
    token_type: 'device', api_url_v2: credentials.apiUrl ?? '', noise_host: credentials.noiseHost ?? '',
    access_token_saved_at: credentials.savedAt ?? Math.floor(Date.now() / 1000) };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(data, null, 2)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
