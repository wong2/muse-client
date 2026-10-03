import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCredentials, saveCredentials, unpair } from '../src/credentials.js';

test('imports gadget credentials and atomically preserves metadata with private file permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'muse-client-test-'));
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

test('unpair removes even malformed credentials, preserves identity/token, and is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'muse-client-unpair-'));
  try {
    await writeFile(join(directory, 'identity.json'), 'identity');
    await writeFile(join(directory, 'sdk_token'), 'token');
    await writeFile(join(directory, 'pairing.json'), 'not json');
    assert.equal(await unpair(directory), true);
    await assert.rejects(readFile(join(directory, 'pairing.json')), { code: 'ENOENT' });
    assert.equal(await readFile(join(directory, 'identity.json'), 'utf8'), 'identity');
    assert.equal(await readFile(join(directory, 'sdk_token'), 'utf8'), 'token');
    assert.equal(await unpair(directory), false);
    assert.equal(await unpair(join(directory, 'absent')), false);
    await assert.rejects(stat(join(directory, 'pair.lock')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unpair respects an active pairing lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'muse-client-unpair-'));
  try {
    await writeFile(join(directory, 'pair.lock'), 'existing lock');
    await writeFile(join(directory, 'pairing.json'), 'keep');
    await assert.rejects(unpair(directory), /locked/);
    assert.equal(await readFile(join(directory, 'pairing.json'), 'utf8'), 'keep');
    assert.equal(await readFile(join(directory, 'pair.lock'), 'utf8'), 'existing lock');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
