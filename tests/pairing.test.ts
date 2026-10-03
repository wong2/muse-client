import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PairingSession, PacketAssembler, encodePackets, identityFromMac } from '../src/pairing/protocol.js';
import { PairingController } from '../src/pairing/controller.js';
import type { DeviceCredentials } from '../src/api.js';

const vector = JSON.parse(readFileSync(new URL('./fixtures/pairing.json', import.meta.url), 'utf8')) as Record<string, string>;
const sdkToken = 'mgst_' + 'A'.repeat(43);
function makeSession(now?: () => number): PairingSession {
  return new PairingSession(identityFromMac(vector.mac!), vector.firmware_version!, {
    privateKey: Buffer.from(vector.device_private_scalar_hex!, 'hex'),
    nonce: Buffer.from(vector.device_nonce!, 'base64url'), now,
  });
}
const hello = { action: 'pairing_client_hello', version: 5, pairing_auth: 'none', pairing_policy: 'confirm_app',
  mobile_pub: vector.mobile_pub, mobile_nonce: vector.mobile_nonce };
const finished = { action: 'pairing_encrypted', session_id: vector.session_id, counter: '0',
  ciphertext: vector.client_finished_ciphertext, tag: vector.client_finished_tag };

function nonce(direction: number, counter: bigint): Buffer {
  const result = Buffer.alloc(12); result[0] = direction; result.writeBigUInt64BE(counter, 4); return result;
}
function seal(value: unknown, counter: bigint): Record<string, unknown> {
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(vector.mobile_tx_key_hex!, 'hex'), nonce(0, counter));
  cipher.setAAD(Buffer.from(`hatch-link ble setup v1|${vector.session_id}|m2d|${counter}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { action: 'pairing_encrypted', session_id: vector.session_id, counter: String(counter),
    ciphertext: data.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}
function open(value: Record<string, unknown>): Record<string, unknown> {
  const counter = BigInt(String(value.counter));
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(vector.mobile_rx_key_hex!, 'hex'), nonce(1, counter));
  cipher.setAAD(Buffer.from(`hatch-link ble setup v1|${vector.session_id}|d2m|${counter}`));
  cipher.setAuthTag(Buffer.from(String(value.tag), 'base64url'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(String(value.ciphertext), 'base64url')), cipher.final()]).toString());
}

test('pairing v5 matches the official public handshake vector and decrypts client confirmation', () => {
  const session = makeSession();
  const ready = session.hello(hello);
  for (const key of ['device_pub', 'device_nonce', 'transcript_hash', 'session_id']) assert.equal(ready[key], vector[key]);
  session.confirm(session.decrypt(finished));
  assert.deepEqual(open(session.encrypt({ type: 'status', status: 'pairing_confirmed', sdk_token: sdkToken })),
    { type: 'status', status: 'pairing_confirmed', sdk_token: sdkToken });
});

test('replayed, tampered and expired records clear pairing keys', () => {
  for (const invalid of [{ ...finished, counter: '1' }, { ...finished, tag: 'A'.repeat(22) }, { ...finished, session_id: 'wrong' }]) {
    const session = makeSession(); session.hello(hello);
    assert.throws(() => session.decrypt(invalid), /decryption/);
    assert.throws(() => session.encrypt({}), /expired/);
  }
  const replay = makeSession(); replay.hello(hello); replay.confirm(replay.decrypt(finished));
  assert.throws(() => replay.decrypt(finished), /decryption/);
  let now = 0;
  const expired = makeSession(() => now); expired.hello(hello); now = 60001;
  assert.throws(() => expired.decrypt(finished), /decryption/);
});

test('only the first encrypted client-finished record confirms a session', () => {
  const session = makeSession(); session.hello(hello);
  assert.throws(() => session.confirm(session.decrypt(seal({ action: 'wifi_scan' }, 0n))), /confirmation/);
  assert.throws(() => session.encrypt({}), /expired/);
});

function harness(options: { probe?: boolean; verify?: (c: DeviceCredentials) => Promise<void>; save?: (c: DeviceCredentials) => void } = {}) {
  const messages: Record<string, unknown>[] = [], errors: Error[] = [], saved: DeviceCredentials[] = [];
  let completed = false;
  const decoder = new PacketAssembler();
  const controller = new PairingController({
    session: makeSession(), sdkToken, probe: options.probe, online: true,
    send: (packets) => {
      for (const packet of packets) {
        assert.ok(packet.length <= 20);
        const raw = decoder.feed(packet);
        if (raw && raw[0] === 123) messages.push(JSON.parse(raw.toString()));
      }
    },
    progress: () => {}, verify: options.verify ?? (async () => {}),
    save: options.save ?? ((c) => saved.push(c)),
    complete: () => { completed = true; }, failed: (e) => errors.push(e),
  });
  return { controller, messages, errors, saved, completed: () => completed,
    send: async (value: unknown) => {
      for (const packet of encodePackets(Buffer.from(JSON.stringify(value)))) await controller.receive(packet);
    },
    statuses: () => messages.filter((m) => m.type === 'pairing_encrypted').map(open),
  };
}
const provision = { action: 'provision_v2', ssid: 'ignored', password: '', token_type: 'device',
  access_token: 'device-access', refresh_token: 'device-refresh', api_url_v2: 'https://api.example.test', noise_host: 'noise.example.test' };

test('complete phone flow verifies before saving and returns encrypted auth_ok', async () => {
  let verified = false;
  const h = harness({ verify: async (c) => { assert.equal(c.accessToken, 'device-access'); verified = true; },
    save: () => { assert.ok(verified); } });
  await h.send({ action: 'get_device_info' });
  assert.equal(h.messages[0]?.node_id, vector.node_id);
  await h.send(hello); await h.send(finished);
  await h.send(seal({ action: 'wifi_scan' }, 1n));
  assert.equal(h.statuses().at(-1)?.type, 'wifi_scan_result');
  await h.send(seal(provision, 2n));
  assert.deepEqual(h.statuses().filter((m) => m.type === 'status').map((m) => m.status),
    ['pairing_confirmed', 'wifi_connecting', 'wifi_connected', 'auth_ok']);
  assert.ok(h.completed()); assert.deepEqual(h.errors, []);
});

test('disconnect during API validation prevents late credentials from being committed', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const h = harness({ verify: () => pending });
  await h.send(hello); await h.send(finished);
  const provisioning = h.send(seal(provision, 1n));
  // Let the packet sequence reach the asynchronous verification call.
  await new Promise((resolve) => setImmediate(resolve));
  h.controller.disconnect(); release(); await provisioning;
  assert.deepEqual(h.saved, []); assert.equal(h.completed(), false);
});

test('rejected credentials and storage failures never report success', async () => {
  for (const options of [{ verify: async () => { throw new Error('401'); } }, { save: () => { throw new Error('disk full'); } }]) {
    const h = harness(options); await h.send(hello); await h.send(finished); await h.send(seal(provision, 1n));
    assert.equal(h.completed(), false); assert.equal(h.errors.length, 1);
    assert.equal(h.statuses().some((m) => m.status === 'auth_ok'), false);
  }
});

test('a replacement handshake invalidates pending credential verification', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const h = harness({ verify: () => pending });
  await h.send(hello); await h.send(finished);
  const provisioning = h.send(seal(provision, 1n));
  await new Promise((resolve) => setImmediate(resolve));
  await h.send(hello); release(); await provisioning;
  assert.deepEqual(h.saved, []); assert.equal(h.completed(), false);
  assert.equal(h.messages.at(-1)?.type, 'pairing_ready');
});

test('probe stops before authorization; plaintext provisioning cannot save credentials', async () => {
  const probe = harness({ probe: true }); await probe.send(hello);
  assert.ok(probe.completed()); assert.equal(probe.messages.length, 0); assert.deepEqual(probe.saved, []);
  const h = harness(); await h.send(provision);
  assert.equal(h.completed(), false); assert.deepEqual(h.saved, []);
});

test('BLE chunks reassemble and reject oversized/out-of-order input', () => {
  const decoder = new PacketAssembler();
  const data = Buffer.alloc(1000, 'x'), packets = encodePackets(data);
  for (const packet of packets.slice(0, -1)) assert.equal(decoder.feed(packet), undefined);
  assert.deepEqual(decoder.feed(packets.at(-1)!), data);
  decoder.feed(packets[0]!); assert.equal(decoder.feed(packets[2]!), undefined);
  assert.throws(() => decoder.feed(Buffer.alloc(8193)), /large/);
});
