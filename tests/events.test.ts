import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeChatEvents } from '../src/events.js';

async function* chunks(...data: Buffer[]): AsyncGenerator<Buffer> { yield* data; }
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}
const delta = { type: 'event', event: 'delta.text_append', seq: 1, payload: { text: '你好🌍' } };

test('decodes UTF-8 split across arbitrary body chunks and ignores subscription acknowledgements', async () => {
  const wire = Buffer.from(JSON.stringify({ type: 'ack' }) + '\n' + JSON.stringify(delta) + '\n');
  const split = wire.indexOf(Buffer.from('好')) + 1;
  const result = await collect(decodeChatEvents(chunks(wire.subarray(0, split), wire.subarray(split))));
  assert.equal(result.length, 1);
  assert.equal(result[0]?.payload.text, '你好🌍');
});

test('deduplicates sequences and decodes a final line without a newline', async () => {
  const next = { ...delta, seq: 2 };
  const wire = Buffer.from([delta, delta, next].map((e) => JSON.stringify(e)).join('\n'));
  const result = await collect(decodeChatEvents(chunks(wire)));
  assert.deepEqual(result.map((e) => e.seq), [1, 2]);
});

test('malformed JSON, truncated UTF-8 and excessive event lines fail explicitly', async () => {
  await assert.rejects(collect(decodeChatEvents(chunks(Buffer.from('{bad}\n')))));
  await assert.rejects(collect(decodeChatEvents(chunks(Buffer.from([0xe4, 0xbd])))));
  await assert.rejects(collect(decodeChatEvents(chunks(Buffer.alloc(1024 * 1024 + 1, 'x')))), /size limit/);
});
