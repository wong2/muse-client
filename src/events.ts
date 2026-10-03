import { object, requiredString } from './api.js';
import { MuseProtocolError } from './errors.js';

export interface ChatEvent {
  type: 'event';
  event: string;
  seq?: number;
  payload: Record<string, unknown>;
  /** Original event, including additional server fields. */
  raw: Record<string, unknown>;
}

/** Internal NDJSON decoder: preserves split UTF-8 characters and ignores replayed sequences. */
export async function* decodeChatEvents(body: AsyncIterable<Buffer>): AsyncGenerator<ChatEvent> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let sequence = 0;
  function parse(line: string): ChatEvent | undefined {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > 1024 * 1024) throw new MuseProtocolError('Chat event exceeds size limit');
    const raw = object(JSON.parse(line));
    if (raw.type !== 'event') return;
    if (typeof raw.seq === 'number' && raw.seq > 0) {
      if (raw.seq <= sequence) return;
      sequence = raw.seq;
    }
    return { type: 'event', event: requiredString(raw.event, 'event name'),
      seq: typeof raw.seq === 'number' ? raw.seq : undefined, payload: object(raw.payload ?? {}), raw };
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let offset: number;
    while ((offset = buffer.indexOf('\n')) >= 0) {
      const event = parse(buffer.slice(0, offset));
      buffer = buffer.slice(offset + 1);
      if (event) yield event;
    }
    if (Buffer.byteLength(buffer) > 1024 * 1024) throw new MuseProtocolError('Chat event exceeds size limit');
  }
  buffer += decoder.decode();
  const last = parse(buffer);
  if (last) yield last;
}
