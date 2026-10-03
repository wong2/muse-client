import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCredentials, saveCredentials } from '../src/credentials.js';

test('imports gadget credentials and atomically preserves metadata with private file permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'muse-ts-test-'));
  try {
    await writeFile(join(directory, 'identity.json'), JSON.stringify({ mac: '02:00:00:ab:cd:ef' }));
    await writeFile(join(directory, 'pairing.json'), JSON.stringify({ access_token: 'a', refresh_token: 'r', username: 'keep-me', api_url: 'legacy' }));
    const credentials = await loadCredentials(directory);
    assert.equal(credentials.deviceId, 'homelink-abcdef');
    await saveCredentials({ ...credentials, accessToken: 'b', refreshToken: 's' }, directory);
    const next = JSON.parse(await readFile(join(directory, 'pairing.json'), 'utf8'));
    assert.equal(next.username, 'keep-me');
    assert.equal(next.access_token, 'b');
    assert.equal(next.api_url, 'legacy');
    assert.equal((await stat(join(directory, 'pairing.json'))).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
