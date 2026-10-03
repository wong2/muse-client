import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { NoiseConnection } from '../src/connection.js';
import type { MuseResponse } from '../src/connection.js';

test('independent Python peer: multiplexing, chunking, cancellation, resets and disconnects', {
  skip: !process.env.MUSE_TEST_PYTHON || !process.env.MUSE_GADGET_SDK,
  timeout: 15000,
}, async () => {
  const server = spawn(process.env.MUSE_TEST_PYTHON!, [fileURLToPath(new URL('./reference_server.py', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: Buffer[] = [];
  server.stderr.on('data', (data: Buffer) => stderr.push(data));
  let connection: NoiseConnection | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Reference server startup timed out')), 5000);
      server.once('error', (error) => { clearTimeout(timer); reject(error); });
      server.once('exit', () => { clearTimeout(timer); reject(new Error(Buffer.concat(stderr).toString())); });
      server.stdout.once('data', (data: Buffer) => { clearTimeout(timer); resolve(Number(data.toString().trim())); });
    });
    connection = await NoiseConnection.connect(`ws://127.0.0.1:${port}`, 'test-only');
    async function collect(response: MuseResponse): Promise<Buffer> {
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) chunks.push(chunk);
      return Buffer.concat(chunks);
    }
    const replies = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const response = await connection!.open('/echo', { index, text: '你好' });
      return JSON.parse((await collect(response)).toString());
    }));
    assert.deepEqual(replies, Array.from({ length: 8 }, (_, index) => ({ index, text: '你好' })));
    assert.deepEqual(await collect(await connection.open('/split', {})), Buffer.alloc(180000, 'x'));
    await assert.rejects(connection.open('/noheaders', {}, { signal: AbortSignal.timeout(30) }), /cancelled/);
    const abort = new AbortController();
    const slow = await connection.open('/slow', {}, { signal: abort.signal });
    const waiting = collect(slow);
    abort.abort();
    await assert.rejects(waiting, /cancelled/);
    await assert.rejects(connection.open('/reset', {}), /reset/);
    assert.equal((await connection.open('/still-works', {})).status, 200);
    const live = await connection.open('/slow', {});
    const reading = assert.rejects(collect(live), /closed/);
    await assert.rejects(connection.open('/disconnect', {}), /closed/);
    await reading;
  } finally {
    connection?.close();
    if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
  }
});
