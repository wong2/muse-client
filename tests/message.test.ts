import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { MuseClient, MuseError, MuseHttpError } from '../src/index.js';
import type { ImageAttachment } from '../src/index.js';
import { NoiseConnection, MAX_REQUEST_BODY_BYTES } from '../src/connection.js';

const picture: ImageAttachment = {
  filename: 'photo.jpg', mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
};

async function harness(t: TestContext, status = 200) {
  const requests: { path: string; body: unknown; signal?: AbortSignal }[] = [];
  let closed = 0;
  t.mock.method(NoiseConnection, 'connect', async () => ({
    async open(path: string, body: unknown, options: { signal?: AbortSignal }) {
      options.signal?.throwIfAborted();
      requests.push({ path, body, signal: options.signal });
      return {
        status,
        body: (async function* () { yield Buffer.from('{"result":{"message_id":"u1","session_id":"side"}}'); })(),
        close() { closed++; },
      };
    },
  }));
  const client = await MuseClient.connect({
    credentials: { accessToken: 'test', refreshToken: '', deviceId: 'test' },
    fetch: async () => Response.json({ vm_list: [{
      vm_id: 'vm', vm_name: 'test', vm_url: 'wss://example.test', vm_auth_token: 'test',
    }] }),
  });
  return { client, requests, get closed() { return closed; } };
}

test('sendMessage sends text and images in one request, preserves bytes and routes the session', async (t) => {
  const h = await harness(t);
  const data = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
  const second: ImageAttachment = { filename: '截图.png', mimeType: 'image/png', data };
  const message = '比较这两张图片："标题"\n\\';
  const ack = await h.client.sendMessage(message, { sessionId: 'side', images: [picture, second] });
  assert.equal(ack.messageId, 'u1');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]?.path, '/chat/stream');
  assert.deepEqual(h.requests[0]?.body, {
    message, output_modality: 'text', session_id: 'side',
    items: [
      { type: 'text', text: message },
      { type: 'file', filename: 'photo.jpg', mime_type: 'image/jpeg', data_base64: '/9j/AA==' },
      { type: 'file', filename: '截图.png', mime_type: 'image/png', data_base64: 'AQID' },
    ],
  });
  assert.equal(h.closed, 1);
});

test('text-only requests remain unchanged, and images may be sent without text', async (t) => {
  const h = await harness(t);
  await h.client.sendMessage('Hello');
  await h.client.sendMessage('Hello', { images: [] });
  for (const request of h.requests) assert.deepEqual(request.body, { message: 'Hello', output_modality: 'text' });
  await h.client.sendMessage('', { images: [picture] });
  assert.deepEqual(h.requests[2]?.body, {
    message: '', output_modality: 'text',
    items: [{ type: 'file', filename: 'photo.jpg', mime_type: 'image/jpeg', data_base64: '/9j/AA==' }],
  });
  await assert.rejects(h.client.sendMessage('  ', { images: [] }), /must not be empty/);
});

test('File and raw attachments can be mixed, with explicit or inferred MIME types', async (t) => {
  const h = await harness(t);
  const file = new File([new Uint8Array([1, 2, 3])], '截图.bin', { type: 'image/png' });
  const inferred = new File([new Uint8Array([4, 5, 6])], 'PHOTO.JPG');
  await h.client.sendMessage('', { images: [file, picture, inferred] });
  assert.deepEqual(h.requests[0]?.body, {
    message: '', output_modality: 'text',
    items: [
      { type: 'file', filename: '截图.bin', mime_type: 'image/png', data_base64: 'AQID' },
      { type: 'file', filename: 'photo.jpg', mime_type: 'image/jpeg', data_base64: '/9j/AA==' },
      { type: 'file', filename: 'PHOTO.JPG', mime_type: 'image/jpeg', data_base64: 'BAUG' },
    ],
  });
});

test('invalid and oversized Files are rejected before reading their contents', async (t) => {
  const h = await harness(t);
  for (const file of [
    new File([], 'empty.jpg', { type: 'image/jpeg' }),
    new File(['data'], '', { type: 'image/jpeg' }),
    new File(['data'], 'unknown.bin'),
    new File(['data'], 'image.jpg', { type: 'text/plain' }),
    new File([new Uint8Array(200 * 1024)], 'large.jpg'),
  ]) {
    t.mock.method(file, 'arrayBuffer', () => assert.fail('Must validate before reading'));
    await assert.rejects(h.client.sendMessage('', { images: [file] }), MuseError);
  }
  assert.equal(h.requests.length, 0);
});

test('File read failures propagate and cancellation during reading prevents sending', async (t) => {
  const h = await harness(t);
  const broken = new File(['data'], 'photo.jpg');
  t.mock.method(broken, 'arrayBuffer', async () => { throw new Error('Cannot read image'); });
  await assert.rejects(h.client.sendMessage('', { images: [broken] }), /Cannot read image/);

  const abort = new AbortController();
  const file = new File(['data'], 'photo.jpg');
  t.mock.method(file, 'arrayBuffer', async () => {
    abort.abort(new Error('Stopped during read'));
    return new ArrayBuffer(4);
  });
  await assert.rejects(h.client.sendMessage('', { images: [file], signal: abort.signal }), /Stopped during read/);
  assert.equal(h.requests.length, 0);
});

test('invalid images are rejected before any request is sent', async (t) => {
  const h = await harness(t);
  for (const images of [
    [{ ...picture, data: new Uint8Array() }],
    [{ ...picture, data: '/9j/AA==' }],
    [{ ...picture, filename: '  ' }],
    [{ ...picture, mimeType: 'text/plain' }],
    [{ ...picture, mimeType: 'image/' }],
    [{ ...picture, mimeType: 'image/jpeg\n' }],
    [null], 'photo.jpg',
  ]) {
    await assert.rejects(h.client.sendMessage('Hello', { images: images as ImageAttachment[] }), MuseError);
  }
  assert.equal(h.requests.length, 0);
});

test('request limit includes base64 expansion, all images, UTF-8 text and metadata', async (t) => {
  const h = await harness(t);
  await h.client.sendMessage('看图', { images: [picture], sessionId: 'side' });
  const overhead = Buffer.byteLength(JSON.stringify(h.requests[0]!.body));
  const remaining = MAX_REQUEST_BODY_BYTES - overhead;
  const extra = '图'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
  await h.client.sendMessage('看图', { images: [{ ...picture, filename: picture.filename + extra }], sessionId: 'side' });
  assert.equal(Buffer.byteLength(JSON.stringify(h.requests[1]!.body)), MAX_REQUEST_BODY_BYTES);
  await assert.rejects(h.client.sendMessage('看图', {
    images: [{ ...picture, filename: picture.filename + extra + 'x' }], sessionId: 'side',
  }), /too large/);
  await assert.rejects(h.client.sendMessage('Hello', {
    images: [{ ...picture, data: Buffer.alloc(200 * 1024) }],
  }), /too large/);
  await assert.rejects(h.client.sendMessage('Hello', {
    images: Array.from({ length: 2 }, () => ({ ...picture, data: Buffer.alloc(100 * 1024) })),
  }), /too large/);
  assert.equal(h.requests.length, 2);
});

test('image send respects cancellation and closes a rejected response', async (t) => {
  const h = await harness(t, 413);
  await assert.rejects(h.client.sendMessage('Look', {
    images: [picture], signal: AbortSignal.abort(new Error('Stopped')),
  }), /Stopped/);
  assert.equal(h.requests.length, 0);
  await assert.rejects(h.client.sendMessage('Look', { images: [picture] }),
    (error: unknown) => error instanceof MuseHttpError && error.status === 413);
  assert.equal(h.closed, 1);
});
