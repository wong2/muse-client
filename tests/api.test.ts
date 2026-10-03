import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MuseAccount } from '../src/api.js';
import type { DeviceCredentials } from '../src/api.js';

const credentials: DeviceCredentials = { accessToken: 'old', refreshToken: 'hatch_refresh:refresh', deviceId: 'homelink-abcdef', sdkToken: 'sdk' };

test('401 rotates and persists tokens before retrying VM lookup', async () => {
  const calls: string[] = [];
  let persisted = false;
  const account = new MuseAccount({ credentials,
    onCredentials: (next) => { assert.equal(next.accessToken, 'new'); persisted = true; },
    fetch: async (url, options) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      const auth = new Headers(options?.headers).get('Authorization');
      if (path === '/device_token/refresh') {
        assert.equal(auth, 'Bearer hatch_refresh:refresh');
        assert.deepEqual(JSON.parse(String(options?.body)), { device_id: 'homelink-abcdef', sdk_token: 'sdk' });
        return Response.json({ payload: { access_token: 'new', refresh_token: 'new-refresh' } });
      }
      if (auth === 'Bearer old') return new Response('', { status: 401 });
      assert.ok(persisted);
      return Response.json({ vm_list: [{ vm_id: 'vm', vm_name: 'Muse', vm_url: 'wss://example.test', vm_auth_token: 'vm-token', default: true }] });
    },
  });
  assert.equal((await account.listVMs())[0]?.id, 'vm');
  assert.deepEqual(calls, ['/fetch_vms', '/device_token/refresh', '/fetch_vms']);
  assert.equal(account.credentials.refreshToken, 'new-refresh');
});

test('concurrent refreshes coalesce and failure does not erase working tokens', async () => {
  let requests = 0;
  const account = new MuseAccount({ credentials, fetch: async () => { requests++; return new Response('', { status: 503 }); } });
  const results = await Promise.allSettled([account.refresh(), account.refresh()]);
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.equal(requests, 1);
  assert.equal(account.credentials.accessToken, 'old');
});

test('persistence failures propagate, while rotated tokens remain available in memory', async () => {
  const account = new MuseAccount({ credentials,
    fetch: async () => Response.json({ access_token: 'new', refresh_token: 'rotated' }),
    onCredentials: () => { throw new Error('Disk full'); },
  });
  await assert.rejects(account.refresh(), /Disk full/);
  assert.equal(account.credentials.refreshToken, 'rotated');
});

test('invalid VM payloads and insecure API URLs fail explicitly', async () => {
  await assert.rejects(new MuseAccount({ credentials, fetch: async () => Response.json({}) }).listVMs(), /vm_list/);
  await assert.rejects(new MuseAccount({ credentials: { ...credentials, apiUrl: 'http://example.test' } }).listVMs(), /HTTPS/);
});
