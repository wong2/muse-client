import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { pairMacOS } from '../src/pairing.js';

function hiddenToken(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Use --sdk-token-file when stdin is not a terminal.');
  console.error('Get your SDK token at https://gadgets.muse.ai/settings/sdk-tokens');
  process.stderr.write('SDK token (hidden): ');
  const mute = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: process.stdin, output: mute, terminal: true });
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (value?: string) => {
      if (done) return;
      done = true; input.close(); mute.end(); process.stderr.write('\n');
      if (value === undefined) reject(new Error('Token input cancelled')); else resolve(value.trim());
    };
    input.on('SIGINT', () => finish());
    input.on('close', () => finish());
    input.question('', (value) => finish(value));
  });
}

export async function runPairCommand(directory: string, tokenFile?: string, probe = false): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Bluetooth pairing currently supports macOS only.');
  if (!probe) {
    let paired = false;
    try { await access(join(directory, 'pairing.json')); paired = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (paired) { console.log('Already paired. Run bun run cli chat.'); return; }
  }
  let sdkToken: string | undefined;
  if (!probe) {
    try { sdkToken = (await readFile(tokenFile ?? join(directory, 'sdk_token'), 'utf8')).trim(); }
    catch (error) {
      if (tokenFile || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      sdkToken = await hiddenToken();
    }
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const credentials = await pairMacOS({ directory, sdkToken, probe, signal: controller.signal,
      onProgress: (message) => console.error(message) });
    console.log(credentials ? 'Paired successfully. Run bun run cli chat.' : 'Discovery probe finished; no credentials were accepted.');
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
