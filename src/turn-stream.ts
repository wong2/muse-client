import type { MuseClient } from './client.js';
import { MuseError } from './errors.js';
import { MuseTurn } from './turn.js';
import type { TurnEvent, TurnOptions } from './turn.js';

export interface ChatOptions extends TurnOptions {
  signal?: AbortSignal;
  /** Overall deadline, including acknowledgement and reply. Default: 120 seconds. */
  timeoutMs?: number;
}

async function until<T>(pending: Promise<T>, ms: number, signal: AbortSignal): Promise<T | undefined> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    return await Promise.race([pending, new Promise<undefined>((resolve, reject) => {
      if (Number.isFinite(ms)) timer = setTimeout(() => resolve(undefined), ms);
      aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    if (aborted) signal.removeEventListener('abort', aborted);
  }
}

/** Internal orchestration, kept independent of the transport for lifecycle tests. */
export async function* followTurn(
  client: Pick<MuseClient, 'subscribe' | 'sendMessage'>, message: string, options: ChatOptions = {},
): AsyncGenerator<TurnEvent> {
  if (!message.trim()) throw new MuseError('Message must not be empty');
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new MuseError('Chat timeout must be a positive integer no greater than 2147483647');
  }
  const turn = new MuseTurn(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new MuseError('Muse reply timed out')), timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let events: Awaited<ReturnType<MuseClient['subscribe']>> | undefined;
  let iterator: AsyncIterator<import('./events.js').ChatEvent> | undefined;
  try {
    signal.throwIfAborted();
    events = await client.subscribe({ sessionId: options.sessionId, signal });
    iterator = events[Symbol.asyncIterator]();
    let next = iterator.next().then((value) => ({ kind: 'event' as const, value }));
    void next.catch(() => {});
    const ack = client.sendMessage(message, { sessionId: options.sessionId, signal })
      .then((value) => ({ kind: 'ack' as const, value }));
    void ack.catch(() => {});
    while (true) {
      const pending = turn.acknowledged ? next : Promise.race([next, ack]);
      const result = await until(pending, turn.completionDelay(), signal);
      if (result === undefined) return;
      let updates: TurnEvent[];
      if (result.kind === 'ack') updates = turn.acknowledge(result.value);
      else {
        if (result.value.done) {
          if (turn.complete()) return;
          throw new MuseError('Muse subscription ended before the reply completed');
        }
        updates = turn.feed(result.value.value);
        next = iterator.next().then((value) => ({ kind: 'event' as const, value }));
        void next.catch(() => {});
      }
      for (const update of updates) {
        if (update.type !== 'reply' || update.bound) yield update;
        signal.throwIfAborted();
      }
      if (turn.complete()) return;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    events?.close();
    try { await iterator?.return?.(); }
    finally { turn.retire(); }
  }
}
