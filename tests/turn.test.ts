import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MuseTurn, ReplayScope, transcriptText } from '../src/turn.js';
import type { ChatEvent, ChatAcknowledgement } from '../src/client.js';

export function event(name: string, payload: Record<string, unknown> = {}, session = 'chat'): ChatEvent {
  const raw = { type: 'event', event: name, payload: { session_id: session, ...payload } };
  return { type: 'event', event: name, payload: raw.payload, raw };
}
export function ack(id = 'u1', session = 'chat', thread = false): ChatAcknowledgement {
  return { messageId: id, raw: { result: { message_id: id, session_id: session, is_thread: thread } } };
}
function shared(): MuseTurn { const turn = new MuseTurn(); turn.acknowledge(ack()); return turn; }
function owned(scope?: ReplayScope, id = 'u1'): MuseTurn {
  const turn = new MuseTurn({ sessionId: 'side', ownsChat: true, replayScope: scope });
  turn.acknowledge(ack(id, 'side', true)); return turn;
}
const reply = (text: string, extra: Record<string, unknown> = {}) =>
  event('delta.message_done', { message_id: 'r1', reply_to_message_id: 'u1', content: text, ...extra });

test('events before acknowledgement are bounded, replayed in order and replaced by final text', () => {
  const turn = new MuseTurn();
  assert.deepEqual(turn.feed(event('delta.text_append', { message_id: 'r1', reply_to_message_id: 'u1', text: 'Hel' })), []);
  turn.feed(event('delta.text_append', { message_id: 'r1', reply_to_message_id: 'u1', text: 'lo' }));
  turn.feed(reply('Hello.'));
  assert.deepEqual(turn.acknowledge(ack()).map((e) => e.type === 'reply' && e.text), ['Hel', 'Hello', 'Hello.']);
  assert.equal(turn.sessionId, 'chat');
  assert.deepEqual(turn.replies.get('r1'), { type: 'reply', messageId: 'r1', text: 'Hello.', streamed: 'Hello', done: true, bound: true });
  assert.throws(() => turn.acknowledge(ack()), /already/);
});

test('other chats, requests, user messages and later parentless deltas of rejected replies are ignored', () => {
  const turn = shared();
  assert.deepEqual(turn.feed(event('delta.message_done', { message_id: 'r2', reply_to_message_id: 'u1' }, 'other')), []);
  assert.deepEqual(turn.feed(reply('Other request', { message_id: 'r2', reply_to_message_id: 'other' })), []);
  assert.deepEqual(turn.feed(event('delta.text_append', { message_id: 'r2', text: 'late' })), []);
  assert.deepEqual(turn.feed(reply('User', { role: 'user' })), []);
  assert.deepEqual(turn.feed(reply('Self', { message_id: 'u1' })), []);
  assert.equal(turn.replies.size, 0);
  turn.feed(reply('Mine'));
  assert.equal(turn.replies.get('r1')?.bound, true);
});

test('parentless shared replies remain unbound until a parent links them, and cannot complete the turn', () => {
  const turn = shared();
  turn.feed(event('delta.message_done', { message_id: 'r1', content: 'Maybe mine' }));
  assert.equal(turn.replies.get('r1')?.bound, false);
  assert.equal(turn.complete(turn.lastActivity + 60000), false);
  turn.feed(reply('Now linked'));
  assert.equal(turn.replies.get('r1')?.bound, true);
  assert.equal(turn.complete(turn.lastActivity + 3000), true);
});

test('shared status from other requests cannot finish or stall the current turn', () => {
  const turn = shared();
  turn.feed(reply('Answer'));
  for (const payload of [{ status: 'completed', reply_to_message_id: 'other' }, { status: 'running' }]) {
    assert.deepEqual(turn.feed(event('task.status', payload)), []);
  }
  assert.equal(turn.busy, false); assert.equal(turn.taskFinished, false);
  assert.equal(turn.complete(turn.lastActivity + 3000), true);
});

test('completion waits for every reply and a terminal task or quiet period', () => {
  const turn = shared();
  assert.equal(turn.complete(turn.lastActivity + 60000), false);
  turn.feed(reply('One'));
  assert.equal(turn.complete(turn.lastActivity + 2999), false);
  assert.equal(turn.complete(turn.lastActivity + 3000), true);
  turn.feed(event('delta.message_start', { message_id: 'r2', reply_to_message_id: 'r1' }));
  assert.equal(turn.complete(turn.lastActivity + 60000), false);
  turn.feed(reply('Two', { message_id: 'r2', reply_to_message_id: 'r1' }));
  turn.feed(event('agent.status', { reply_to_message_id: 'u1', activity_code: 'working' }));
  assert.equal(turn.complete(turn.lastActivity + 60000), false);
  assert.deepEqual(turn.feed(event('task.status', { reply_to_message_id: 'u1', status: 'completed' })), [{ type: 'task-finished' }]);
  assert.equal(turn.complete(), true);
});

test('terminal tasks preceding blank or missing replies allow reordered text to arrive', (t) => {
  // Subtracting this timestamp from its deadline rounds below the full grace period.
  t.mock.method(performance, 'now', () => 24.0003);
  const turn = shared();
  turn.feed(event('task.status', { reply_to_message_id: 'u1', status: 'completed' }));
  assert.equal(turn.complete(turn.lastActivity + 2999), false);
  assert.equal(turn.complete(turn.lastActivity + 3000), true);
  turn.feed(event('delta.message_start', { message_id: 'r1', reply_to_message_id: 'u1' }));
  assert.equal(turn.complete(turn.lastActivity + 60000), false);
  turn.feed(reply(' '));
  assert.equal(turn.complete(turn.lastActivity + 999), false);
  assert.equal(turn.complete(turn.lastActivity + 1000), true);
  turn.feed(reply('Late final'));
  assert.equal(turn.complete(), true);
});

test('owned chats require matching acknowledgement and wait for the last running task', () => {
  assert.throws(() => new MuseTurn({ ownsChat: true }), /session ID/);
  for (const response of [ack('u1', 'other', true), ack('u1', 'side', false)]) {
    assert.throws(() => new MuseTurn({ sessionId: 'side', ownsChat: true }).acknowledge(response), /dedicated/);
  }
  const turn = owned();
  assert.deepEqual(turn.feed(event('task.status', { task_id: 'old', status: 'completed' }, 'side')), []);
  for (const task_id of ['root', 'sub']) turn.feed(event('task.status', { task_id, status: 'running' }, 'side'));
  turn.feed(event('delta.message_done', { message_id: 'r1', content: 'Answer' }, 'side'));
  turn.feed(event('task.status', { task_id: 'sub', status: 'completed' }, 'side'));
  assert.equal(turn.complete(turn.lastActivity + 60000), false);
  turn.feed(event('task.status', { task_id: 'root', status: 'completed' }, 'side'));
  assert.equal(turn.complete(), true);
});

test('replay scope filters retired replies, parents, tasks, idle events and stopped requests', () => {
  const scope = new ReplayScope();
  const first = owned(scope);
  first.feed(event('task.status', { task_id: 't1', status: 'running' }, 'side'));
  first.feed(event('delta.message_done', { message_id: 'r1', content: 'First' }, 'side'));
  first.retire();
  scope.retireRequest(ack('stop', 'side', true));
  scope.observeIdle(event('agent.status', { message_id: 'idle', activity_code: 'working' }, 'side'), 'side');
  const second = owned(scope, 'u2');
  for (const e of [
    event('task.status', { task_id: 't1', status: 'completed' }, 'side'),
    event('delta.message_done', { message_id: 'r1', content: 'Replay' }, 'side'),
    event('delta.message_done', { message_id: 'r9', reply_to_message_id: 'u1', content: 'Late' }, 'side'),
    event('delta.message_done', { message_id: 'r3', reply_to_message_id: 'stop' }, 'side'),
    event('agent.status', { message_id: 'idle', activity_code: 'working' }, 'side'),
  ]) assert.deepEqual(second.feed(e), []);
  assert.equal(second.busy, false);
  second.feed(event('delta.message_done', { message_id: 'r2', content: 'Second' }, 'side'));
  assert.equal(second.replies.get('r2')?.bound, true);
  const bounded = new ReplayScope(2);
  bounded.retire(['a', 'b', 'c']);
  assert.equal(bounded.has('a'), false); assert.equal(bounded.has('c'), true);
});

test('display readiness, late deltas, structured transcripts and terminal control characters', () => {
  const turn = shared();
  const transcript = { messages: [
    { id: 'r0', role: 'assistant', content: [{ type: 'text', text: 'Old' }] },
    { id: 'r1', role: 'assistant', content: [{ type: 'text', text: 'Final\x1b\x07\n' }, { type: 'image', text: 'Ignore' }] },
    { id: 'tool', role: 'tool', content: [{ type: 'text', text: 'Private' }] },
  ] };
  turn.feed(event('message.assistant', { message_id: 'r1', reply_to_message_id: 'u1', content: 'Draft', display_text_ready: false }));
  assert.equal(turn.replies.get('r1')?.done, false);
  turn.feed(event('delta.message_done', { message_id: 'r1', reply_to_message_id: 'u1', transcript }));
  turn.feed(event('delta.text_append', { message_id: 'r1', text: ' late' }));
  assert.equal(turn.replies.get('r1')?.text, 'Final\n');
  assert.equal(transcriptText(transcript, 'r0'), 'Old');
  assert.deepEqual(turn.feed(event('agent.status', { reply_to_message_id: 'u1', activity_code: 'new-code', activity_text: 'Searching\x1b\x00\t' })),
    [{ type: 'agent-status', activityCode: 'new-code', activityText: 'Searching\t' }]);
  const snapshot = turn.replies as Map<string, unknown>;
  snapshot.clear(); assert.equal(turn.replies.size, 1);
  assert.ok(Object.isFrozen(turn.replies.get('r1')));
});

test('pending events, UTF-8 reply size, identifiers and message counts have limits', () => {
  const pending = new MuseTurn();
  for (let i = 0; i < 64; i++) pending.feed(event('delta.message_start', { message_id: `r${i}` }));
  assert.throws(() => pending.feed(reply('overflow')), /before acknowledgement/);
  assert.throws(() => new MuseTurn().feed(event('message.assistant', { transcript: { text: 'x'.repeat(65536) } })), /before acknowledgement/);
  assert.throws(() => shared().feed(reply('é'.repeat(33000))), /64 KiB/);
  assert.throws(() => shared().feed(reply('', { message_id: 'é'.repeat(257) })), /identifier/);
  const many = shared();
  for (let i = 0; i < 32; i++) many.feed(reply('Answer', { message_id: `r${i}` }));
  assert.throws(() => many.feed(reply('Answer', { message_id: 'overflow' })), /Too many messages/);
});
