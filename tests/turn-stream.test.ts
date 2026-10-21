import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followTurn } from '../src/turn-stream.js';
import type { ChatAcknowledgement, ChatEvent, SendOptions } from '../src/client.js';

function event(name: string, payload: Record<string, unknown>): ChatEvent {
  const raw = { type: 'event', event: name, payload: { session_id: 'chat', ...payload } };
  return { ...raw, type: 'event', raw };
}
const ack: ChatAcknowledgement = { messageId: 'u1', raw: { result: { message_id: 'u1', session_id: 'chat' } } };
function harness() {
  const queue: ChatEvent[] = [];
  let wake: (() => void) | undefined, ended = false, error: unknown;
  let subscribed = false, closed = false, sent = false;
  let sentMessage: string | undefined, sentOptions: SendOptions | undefined;
  let accept!: (ack: ChatAcknowledgement) => void, reject!: (reason: Error) => void;
  const acknowledgement = new Promise<ChatAcknowledgement>((resolve, fail) => { accept = resolve; reject = fail; });
  void acknowledgement.catch(() => {});
  return {
    emit(e: ChatEvent) { queue.push(e); wake?.(); },
    end() { ended = true; wake?.(); },
    accept, reject,
    get closed() { return closed; },
    get sent() { return sent; },
    get sentMessage() { return sentMessage; },
    get sentOptions() { return sentOptions; },
    client: {
      async subscribe(options: { signal?: AbortSignal } = {}) {
        subscribed = true;
        const abort = () => { error = options.signal?.reason; ended = true; wake?.(); };
        options.signal?.addEventListener('abort', abort, { once: true });
        return {
          close() { closed = true; ended = true; options.signal?.removeEventListener('abort', abort); wake?.(); },
          async *[Symbol.asyncIterator]() {
            while (true) {
              if (error) throw error;
              const value = queue.shift();
              if (value) yield value;
              else if (ended) return;
              else await new Promise<void>((resolve) => { wake = resolve; });
            }
          },
        };
      },
      async sendMessage(message: string, options?: SendOptions) {
        assert.ok(subscribed, 'subscribe before sending');
        sent = true;
        sentMessage = message; sentOptions = options;
        return acknowledgement;
      },
    },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

test('chat forwards images with text or alone and follows the same turn', async () => {
  const images = [
    { data: Buffer.from([0xff, 0xd8, 0xff]), filename: 'photo.jpg', mimeType: 'image/jpeg' },
    new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' }),
  ];
  for (const message of ['Describe this', '']) {
    const h = harness();
    const reading = collect(followTurn(h.client, message, { images, sessionId: 'chat' }));
    await tick();
    assert.equal(h.sentMessage, message);
    assert.equal(h.sentOptions?.images, images);
    assert.equal(h.sentOptions?.sessionId, 'chat');
    assert.ok(h.sentOptions?.signal instanceof AbortSignal);
    h.accept(ack);
    h.emit(event('delta.message_done', { message_id: 'r1', reply_to_message_id: 'u1', content: 'A picture' }));
    h.emit(event('task.status', { reply_to_message_id: 'u1', status: 'completed' }));
    assert.deepEqual((await reading).map((e) => e.type), ['reply', 'task-finished']);
    assert.ok(h.closed);
  }
});

test('invalid images fail before subscribing, and image turns clean up on cancellation', async () => {
  const h = harness();
  await assert.rejects(collect(followTurn(h.client, '', {
    images: [{ data: Buffer.alloc(0), filename: 'photo.jpg', mimeType: 'image/jpeg' }],
  })), /non-empty Uint8Array/);
  assert.equal(h.sent, false);
  assert.equal(h.closed, false);
  const abort = new AbortController();
  const reading = assert.rejects(collect(followTurn(h.client, '', {
    images: [{ data: Buffer.from([1]), filename: 'photo.jpg', mimeType: 'image/jpeg' }], signal: abort.signal,
  })), /Stopped/);
  await tick(); abort.abort(new Error('Stopped'));
  await reading;
  assert.ok(h.closed);
});

test('chat reads events while acknowledgement is pending, yields only bound replies and cleans up', async () => {
  const h = harness();
  const reading = collect(followTurn(h.client, 'Hello'));
  await tick();
  assert.ok(h.sent);
  h.emit(event('delta.message_done', { message_id: 'unknown', content: 'Unrelated' }));
  h.emit(event('delta.text_append', { message_id: 'r1', reply_to_message_id: 'u1', text: 'Hel' }));
  h.emit(event('delta.message_done', { message_id: 'r1', reply_to_message_id: 'u1', content: 'Hello!' }));
  h.emit(event('task.status', { reply_to_message_id: 'u1', status: 'completed' }));
  await tick();
  h.accept(ack);
  const events = await reading;
  assert.deepEqual(events.map((e) => e.type), ['reply', 'reply', 'task-finished']);
  assert.equal(events[1]?.type === 'reply' && events[1].text, 'Hello!');
  assert.ok(h.closed);
});

test('chat releases subscriptions on early consumer return and acknowledgement failure', async () => {
  const h = harness();
  const stream = followTurn(h.client, 'Hello');
  const next = stream.next();
  await tick(); h.accept(ack);
  h.emit(event('delta.text_append', { message_id: 'r1', reply_to_message_id: 'u1', text: 'Hello' }));
  assert.equal((await next).value?.type, 'reply');
  await stream.return(undefined);
  assert.ok(h.closed);
  const failed = harness();
  const reading = assert.rejects(collect(followTurn(failed.client, 'Hello')), /Rejected/);
  await tick(); failed.reject(new Error('Rejected'));
  await reading; assert.ok(failed.closed);
});

test('chat aborts or times out while waiting for acknowledgement or more reply events', async () => {
  for (const acknowledged of [false, true]) {
    const h = harness();
    const reading = assert.rejects(collect(followTurn(h.client, 'Hello', { timeoutMs: 30 })), /timed out/);
    if (acknowledged) h.accept(ack);
    await reading; assert.ok(h.closed);
  }
  const h = harness(), abort = new AbortController();
  const reading = assert.rejects(collect(followTurn(h.client, 'Hello', { signal: abort.signal })), /Stopped/);
  await tick(); abort.abort(new Error('Stopped'));
  await reading; assert.ok(h.closed);
});

test('chat reports a premature subscription end instead of treating it as a completed reply', async () => {
  const h = harness();
  const reading = assert.rejects(collect(followTurn(h.client, 'Hello')), /ended before/);
  await tick(); h.accept(ack); h.end();
  await reading; assert.ok(h.closed);
});

test('chat completes after quiet when no terminal status arrives', async () => {
  const h = harness();
  const reading = collect(followTurn(h.client, 'Hello', { timeoutMs: 10000 }));
  await tick(); h.accept(ack);
  h.emit(event('delta.message_done', { message_id: 'r1', reply_to_message_id: 'u1', content: 'Answer' }));
  const events = await reading;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'reply');
  assert.ok(h.closed);
});

test('terminal status before the answer does not prematurely close the stream', async () => {
  const h = harness();
  const reading = collect(followTurn(h.client, 'Hello'));
  await tick(); h.accept(ack);
  h.emit(event('task.status', { reply_to_message_id: 'u1', status: 'completed' }));
  await tick();
  assert.equal(h.closed, false);
  h.emit(event('delta.message_done', { message_id: 'r1', reply_to_message_id: 'u1', content: 'Late text' }));
  assert.deepEqual((await reading).map((e) => e.type), ['task-finished', 'reply']);
  assert.ok(h.closed);
});

test('cancellation while the consumer is processing a reply is observed on resumption', async () => {
  const h = harness(), abort = new AbortController();
  const stream = followTurn(h.client, 'Hello', { signal: abort.signal });
  const next = stream.next();
  await tick(); h.accept(ack);
  h.emit(event('delta.message_done', { message_id: 'r1', reply_to_message_id: 'u1', content: 'Answer' }));
  await next;
  abort.abort(new Error('Stopped'));
  await assert.rejects(stream.next(), /Stopped/);
  assert.ok(h.closed);
});
