// Adapted from Meta's muse-gadget-sdk muse_turn.py (Apache-2.0). See NOTICE.
import type { ChatAcknowledgement } from './client.js';
import type { ChatEvent } from './events.js';
import { MuseError, MuseProtocolError } from './errors.js';

export interface Reply {
  readonly type: 'reply';
  readonly messageId: string;
  /** Best current text, replaced by the final text when available. */
  readonly text: string;
  readonly streamed: string;
  readonly done: boolean;
  /** Proven to answer this request, or received in its exclusively owned chat. */
  readonly bound: boolean;
}
export interface AgentStatus {
  readonly type: 'agent-status';
  readonly activityCode?: string;
  readonly activityText?: string;
}
export interface TaskFinished { readonly type: 'task-finished' }
export type TurnEvent = Reply | AgentStatus | TaskFinished;
export interface TurnOptions {
  sessionId?: string;
  /** Only set for an existing side chat used exclusively by this caller. */
  ownsChat?: boolean;
  replayScope?: ReplayScope;
}

const QUIET_MS = 3000;
const MAX_TEXT_BYTES = 64 * 1024;
const TERMINAL = new Set(['completed', 'failed', 'errored', 'cancelled', 'canceled']);
const MESSAGE_EVENTS = new Set(['delta.message_start', 'delta.text_append', 'delta.message_done', 'message.assistant']);
const STATUS_EVENTS = new Set(['agent.status', 'task.status']);
const string = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const clean = (text: string): string => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function identifier(value: unknown): string | undefined {
  const id = string(value);
  if (id && Buffer.byteLength(id) > 512) throw new MuseProtocolError('Muse returned an oversized chat identifier');
  return id;
}
function eventIds(event: ChatEvent, includeParents = true): Set<string> {
  const ids = new Set<string>();
  const keys = ['message_id', 'id', 'task_id', ...(includeParents ? ['reply_to_message_id', 'parent_message_id'] : [])];
  for (const key of keys) {
    const id = identifier(event.payload[key]);
    if (id) ids.add(`${key === 'task_id' ? 'task' : 'message'}:${id}`);
  }
  const id = identifier(event.raw.message_id);
  if (id) ids.add(`message:${id}`);
  return ids;
}
function acknowledgementIds(ack: ChatAcknowledgement): Set<string> {
  const ids = new Set([identifier(ack.messageId), identifier(ack.replyToMessageId)].filter((id): id is string => !!id));
  if (!ids.size) throw new MuseProtocolError('Muse acknowledgement omitted the user message ID');
  return ids;
}

/** Bounded replay history. Share across sequential turns in an exclusively owned side chat. */
export class ReplayScope {
  private readonly ids = new Set<string>();
  constructor(private readonly limit = 2048) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new MuseError('Replay limit must be a positive integer');
  }
  has(id: string): boolean { return this.ids.has(id); }
  retire(ids: Iterable<string>): void {
    for (const id of ids) {
      this.ids.add(id);
      if (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value!);
    }
  }
  retireRequest(ack: ChatAcknowledgement): void {
    this.retire([...acknowledgementIds(ack)].map((id) => `message:${id}`));
  }
  observeIdle(event: ChatEvent, sessionId: string): void {
    if ((event.payload.session_id ?? event.raw.session_id) === sessionId
        && (STATUS_EVENTS.has(event.event) || MESSAGE_EVENTS.has(event.event))) this.retire(eventIds(event));
  }
}

/** Extract only assistant text from a structured transcript. */
export function transcriptText(value: unknown, messageId?: string): string {
  if (typeof value === 'string') return value;
  const messages = record(value)?.messages;
  if (!Array.isArray(messages)) return '';
  const message = messages.map(record).filter((m) => m?.role === 'assistant' && (!messageId || m.id === messageId)).at(-1);
  if (!Array.isArray(message?.content)) return '';
  return message.content.map(record).filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item!.text).join('\n');
}

/**
 * Tracks one request. Create before sending, feed subscription events, then acknowledge.
 * Times use performance.now() milliseconds. A message's done flag does not end a turn.
 */
export class MuseTurn {
  private session?: string;
  private acked = false;
  private active = false;
  private finished = false;
  private activity?: string;
  private last = performance.now();
  private userIds = new Set<string>();
  private readonly messages = new Map<string, Reply>();
  private pending: ChatEvent[] = [];
  private pendingBytes = 0;
  private readonly observed = new Set<string>();
  private readonly runningTasks = new Set<string>();
  private readonly ignored = new Set<string>();

  constructor(private readonly options: TurnOptions = {}) {
    this.session = options.sessionId;
    if (options.ownsChat && !options.sessionId) throw new MuseError('An owned chat requires a session ID');
  }
  get sessionId(): string | undefined { return this.session; }
  get acknowledged(): boolean { return this.acked; }
  get busy(): boolean { return this.active; }
  get taskFinished(): boolean { return this.finished; }
  get activityCode(): string | undefined { return this.activity; }
  get lastActivity(): number { return this.last; }
  /** Snapshot; mutating the returned map cannot change this turn. */
  get replies(): ReadonlyMap<string, Reply> { return new Map(this.messages); }

  acknowledge(ack: ChatAcknowledgement): TurnEvent[] {
    if (this.acked) throw new MuseError('Turn is already acknowledged');
    const ids = acknowledgementIds(ack);
    const result = record(ack.raw.result) ?? ack.raw;
    const session = identifier(result.session_id);
    if (this.options.ownsChat && (session !== this.session || result.is_thread !== true)) {
      throw new MuseProtocolError('Muse did not acknowledge the dedicated side chat');
    }
    if (session && this.session && session !== this.session) throw new MuseProtocolError('Muse acknowledged a different chat');
    this.session ??= session;
    this.userIds = ids;
    this.acked = true;
    const pending = this.pending;
    this.pending = []; this.pendingBytes = 0;
    return pending.flatMap((event) => this.feed(event));
  }

  feed(event: ChatEvent): TurnEvent[] {
    if (!MESSAGE_EVENTS.has(event.event) && !STATUS_EVENTS.has(event.event)) return [];
    const session = identifier(event.payload.session_id ?? event.raw.session_id);
    if (this.options.ownsChat ? session !== this.session : session && this.session && session !== this.session) return [];
    const ids = eventIds(event);
    if (this.options.ownsChat) {
      const ownIds = eventIds(event, false);
      if ([...ownIds].some((id) => this.options.replayScope?.has(id))) return [];
      if (this.acked && [...ids].some((id) => !ownIds.has(id) && !this.userIds.has(id.slice('message:'.length))
          && this.options.replayScope?.has(id))) return [];
      for (const id of ids) this.observed.add(id);
      if (this.observed.size > 256) throw new MuseProtocolError('Too many identifiers for one turn');
    }
    if (!this.acked) {
      // Bound all retained data, including structured transcripts and unknown fields.
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (this.pending.length >= 64 || this.pendingBytes + bytes > MAX_TEXT_BYTES) {
        throw new MuseProtocolError('Too many chat events before acknowledgement');
      }
      this.pending.push(structuredClone(event)); this.pendingBytes += bytes;
      return [];
    }
    return STATUS_EVENTS.has(event.event) ? this.status(event) : this.message(event);
  }

  private status(event: ChatEvent): TurnEvent[] {
    const p = event.payload;
    const parent = identifier(p.reply_to_message_id ?? p.parent_message_id);
    const reply = this.messages.get(identifier(p.message_id) ?? '');
    const linked = !!parent && (this.userIds.has(parent) || this.messages.get(parent)?.bound === true)
      || reply?.bound === true;
    const task = identifier(p.task_id);
    // Shared chat activity without a proven link cannot complete or stall this request.
    if (!this.options.ownsChat && !linked && !(task && this.runningTasks.has(task))) return [];
    if (parent && !linked && !this.options.ownsChat) return [];
    const status = string(p.status);
    const activity = typeof p.activity_code === 'string' ? p.activity_code : undefined;
    const terminal = !!status && TERMINAL.has(status);
    const wasFinished = this.finished;
    if (event.event === 'task.status') {
      if (terminal && this.options.ownsChat && !linked && !(task && this.runningTasks.has(task))) return [];
      if (status === 'running' && task) {
        if (this.runningTasks.size >= 256 && !this.runningTasks.has(task)) throw new MuseProtocolError('Too many tasks for one turn');
        this.runningTasks.add(task);
      }
      if (terminal && task) this.runningTasks.delete(task);
      if (status) this.finished = terminal && this.runningTasks.size === 0;
    }
    if (activity !== undefined) {
      this.active = !['', 'online', 'idle'].includes(activity) && !TERMINAL.has(activity);
      if (event.event === 'agent.status') this.activity = activity;
    } else if (status) this.active = status !== 'idle' && !terminal;
    if (this.runningTasks.size) { this.active = true; this.finished = false; }
    else if (event.event === 'task.status' && this.finished) this.active = false;
    this.last = performance.now();
    if (event.event === 'agent.status' && !this.finished) {
      return [Object.freeze({ type: 'agent-status', activityCode: activity,
        activityText: typeof p.activity_text === 'string' ? clean(p.activity_text) : undefined })];
    }
    return this.finished && !wasFinished ? [Object.freeze({ type: 'task-finished' })] : [];
  }

  private message(event: ChatEvent): TurnEvent[] {
    const p = event.payload;
    const id = identifier(p.message_id ?? event.raw.message_id ?? p.id);
    if (!id || p.role === 'user' || this.userIds.has(id)) return [];
    const parent = identifier(p.reply_to_message_id ?? p.parent_message_id);
    let reply = this.messages.get(id);
    if (this.ignored.has(id)) return [];
    if (parent && !this.userIds.has(parent) && !this.messages.has(parent)
        && !(this.options.ownsChat && parent === id)) {
      if (!reply) {
        this.ignored.add(id);
        if (this.ignored.size > 256) this.ignored.delete(this.ignored.values().next().value!);
      }
      return [];
    }
    if (!reply) {
      if (this.messages.size >= 32) throw new MuseProtocolError('Too many messages for one turn');
      reply = { type: 'reply', messageId: id, text: '', streamed: '', done: false, bound: false };
    }
    const bound = reply.bound || !!this.options.ownsChat || !!parent
      && (this.userIds.has(parent) || this.messages.get(parent)?.bound === true);
    let { text, streamed, done } = reply;
    if (event.event === 'delta.text_append' && typeof p.text === 'string' && !done) {
      const delta = clean(p.text);
      text += delta; streamed += delta;
    }
    if (event.event === 'delta.message_done' || event.event === 'message.assistant') {
      let final: unknown = p.display_text;
      if (typeof final !== 'string') {
        final = transcriptText(p.transcript, id);
        if (!final && typeof p.transcript !== 'string') final = p.content;
      }
      if (typeof final === 'string') text = clean(final);
      if (event.event === 'delta.message_done' || p.display_text_ready !== false) done = true;
    }
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES || Buffer.byteLength(streamed) > MAX_TEXT_BYTES) {
      throw new MuseProtocolError('Muse returned more than 64 KiB of reply text');
    }
    const next: Reply = Object.freeze({ type: 'reply', messageId: id, text, streamed, done, bound });
    this.messages.set(id, next);
    if (bound) this.last = performance.now();
    return [next];
  }

  /** Earliest possible completion check, in milliseconds; Infinity means more events are needed. */
  completionDelay(now = performance.now()): number {
    if (!this.acked || this.active) return Infinity;
    const replies = [...this.messages.values()].filter((reply) => reply.bound);
    if (replies.some((reply) => !reply.done)) return Infinity;
    if (replies.some((reply) => reply.text.trim())) {
      return this.finished ? 0 : Math.max(0, QUIET_MS - (now - this.last));
    }
    // A terminal task may precede its reply; allow reordered text to arrive.
    return this.finished ? Math.max(0, (replies.length ? 1000 : QUIET_MS) - (now - this.last)) : Infinity;
  }
  complete(now = performance.now()): boolean { return this.completionDelay(now) === 0; }
  retire(): void {
    if (!this.options.ownsChat || !this.options.replayScope) return;
    this.options.replayScope.retire(this.observed);
    this.options.replayScope.retire([...this.userIds].map((id) => `message:${id}`));
    for (const event of this.pending) this.options.replayScope.retire(eventIds(event));
  }
}
