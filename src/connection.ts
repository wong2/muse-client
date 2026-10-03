import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { MuseError, MuseHttpError, MuseProtocolError } from './errors.js';
import { CipherState, NoiseInitiator } from './noise/crypto.js';
import { FrameAssembler, frameChunks, requestFrame, resetFrame, responseFrame } from './noise/wire.js';

class BodyQueue implements AsyncIterable<Buffer> {
  private chunks: Buffer[] = [];
  private size = 0;
  private ended = false;
  private error?: Error;
  private wake?: () => void;
  push(chunk: Buffer): void {
    if (!chunk.length || this.ended) return;
    if (this.size + chunk.length > 4 * 1024 * 1024) throw new MuseProtocolError('Response consumer is too slow');
    this.chunks.push(chunk);
    this.size += chunk.length;
    this.wake?.();
  }
  end(error?: Error): void { this.ended = true; this.error = error; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    while (true) {
      if (this.error) throw this.error;
      const chunk = this.chunks.shift();
      if (chunk) { this.size -= chunk.length; yield chunk; }
      else if (this.ended) return;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

interface Pending {
  queue: BodyQueue;
  status?: number;
  resolve: (status: number) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  headersTimer: ReturnType<typeof setTimeout>;
}
export interface MuseResponse {
  status: number;
  body: AsyncIterable<Buffer>;
  close(): void;
}

/** Internal multiplexed HTTP-over-Noise connection. */
export class NoiseConnection {
  private sendCipher?: CipherState;
  private receiveCipher?: CipherState;
  private readonly assembler = new FrameAssembler();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private dead = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pong = true;
  private constructor(private readonly socket: WebSocket) {}

  static connect(url: string, token: string): Promise<NoiseConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'muse-client/0.1.0' },
        handshakeTimeout: 20000, maxPayload: 4 * 1024 * 1024,
        perMessageDeflate: false, followRedirects: false,
      });
      const connection = new NoiseConnection(socket);
      const handshake = new NoiseInitiator();
      let established = false;
      const timer = setTimeout(() => fail(new MuseError('Noise handshake timed out')), 20000);
      function fail(error: Error): void {
        clearTimeout(timer);
        connection.fail(error);
        reject(error);
      }
      socket.on('error', () => fail(new MuseError('Muse WebSocket connection failed')));
      socket.on('unexpected-response', (_request, response) => {
        response.resume();
        fail(new MuseHttpError(response.statusCode ?? 0, '/v1/noise'));
      });
      socket.on('close', () => fail(new MuseError('Muse connection closed')));
      socket.on('open', () => {
        try { socket.send(handshake.message1()); } catch (error) { fail(asError(error)); }
      });
      socket.on('pong', () => { connection.pong = true; });
      socket.on('message', (raw, binary) => {
        try {
          if (!binary) throw new MuseProtocolError('Expected binary Noise message');
          const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : Buffer.concat(raw));
          if (!established) {
            handshake.receiveMessage2(data);
            const keys = handshake.finish();
            connection.sendCipher = keys.send;
            connection.receiveCipher = keys.receive;
            socket.send(keys.message);
            established = true;
            clearTimeout(timer);
            connection.heartbeat = setInterval(() => {
              if (!connection.pong) { fail(new MuseError('Muse heartbeat timed out')); return; }
              connection.pong = false;
              socket.ping();
            }, 20000);
            connection.heartbeat.unref();
            resolve(connection);
          } else connection.receive(data);
        } catch (error) { fail(asError(error)); }
      });
    });
  }

  private receive(data: Buffer): void {
    const envelope = this.assembler.decode(this.receiveCipher!.decrypt(data));
    if (!envelope) return;
    const frame = responseFrame(envelope);
    const pending = this.pending.get(frame.streamId);
    if (!pending) return; // A cancelled stream can still have in-flight frames.
    if (frame.kind === 'reset') {
      this.finish(frame.streamId, new MuseError('Muse reset the request stream'));
      return;
    }
    if (frame.kind === 'response') {
      if (pending.status !== undefined) throw new MuseProtocolError('Duplicate response headers');
      pending.status = frame.status!;
      clearTimeout(pending.headersTimer);
      pending.resolve(frame.status!);
    } else if (pending.status === undefined) throw new MuseProtocolError('Body arrived before headers');
    pending.queue.push(frame.body);
    if (frame.end) this.finish(frame.streamId);
  }

  private finish(id: number, error?: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    if (error) pending.reject(error);
    else if (pending.status === undefined) pending.reject(new MuseProtocolError('Response ended before headers'));
    pending.queue.end(error);
  }

  private transmit(data: Buffer): void {
    if (this.dead || !this.sendCipher || this.socket.readyState !== WebSocket.OPEN) throw new MuseError('Muse is not connected');
    if (this.socket.bufferedAmount > 4 * 1024 * 1024) throw new MuseError('Muse outbound buffer is full');
    // Encode/encrypt/send synchronously so concurrent streams cannot reorder nonces.
    for (const frame of frameChunks(data)) {
      this.socket.send(this.sendCipher.encrypt(frame), (error) => { if (error) this.fail(new MuseError('Muse send failed')); });
    }
  }

  async open(path: string, body: unknown, options: { signal?: AbortSignal } = {}): Promise<MuseResponse> {
    if (this.dead) throw new MuseError('Muse connection is closed');
    options.signal?.throwIfAborted();
    if (this.pending.size >= 64) throw new MuseError('Too many concurrent Muse requests');
    const id = this.nextId++;
    const queue = new BodyQueue();
    const close = () => {
      if (!this.pending.has(id)) return;
      this.finish(id, new MuseError('Muse request cancelled'));
      try { this.transmit(resetFrame(id)); } catch (error) { this.fail(asError(error)); }
    };
    const status = new Promise<number>((resolve, reject) => {
      const headersTimer = setTimeout(() => {
        this.finish(id, new MuseError('Muse response headers timed out'));
        try { this.transmit(resetFrame(id)); } catch (error) { this.fail(asError(error)); }
      }, 20000);
      this.pending.set(id, { queue, resolve, reject, headersTimer,
        cleanup: () => { clearTimeout(headersTimer); options.signal?.removeEventListener('abort', close); },
      });
      options.signal?.addEventListener('abort', close, { once: true });
      try {
        const encoded = Buffer.from(JSON.stringify(body));
        if (encoded.length > 256 * 1024 - 1024) throw new MuseError('Muse request body is too large');
        this.transmit(requestFrame(id, 'POST', path, encoded, {
          'Content-Type': 'application/json', accept: 'application/x-ndjson',
          'x-request-id': randomUUID(), 'x-app-id': 'hatch-web',
        }));
      } catch (error) { this.finish(id, asError(error)); }
    });
    return { status: await status, body: queue, close };
  }

  private fail(error: Error): void {
    if (this.dead) return;
    this.dead = true;
    clearInterval(this.heartbeat);
    for (const id of this.pending.keys()) this.finish(id, error);
    this.socket.terminate();
  }
  close(): void { this.fail(new MuseError('Muse connection closed by client')); }
}

function asError(error: unknown): Error { return error instanceof Error ? error : new MuseError('Muse protocol failed'); }
