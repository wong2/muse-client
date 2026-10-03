#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { MuseAccount, MuseClient } from '../src/index.js';
import type { ChatEvent } from '../src/index.js';
import { defaultCredentialsDirectory, loadCredentials, saveCredentials, unpair } from '../src/credentials.js';

const HELP = `Muse CLI example

  bun run cli pair                        Pair this Mac using the Muse phone app
  bun run cli pair --probe                Test Bluetooth discovery without authorization
  bun run cli unpair                      Remove local pairing credentials
  bun run cli vms                         List available Muse VMs
  bun run cli check                       Connect and open a chat subscription
  bun run cli chat                        Interactive text chat
  bun run cli send "Hello"                Send a message (prints acknowledgement)
  bun run cli watch                       Watch chat events

Options:
  --credentials <directory>   Pairing-file directory (defaults to the local gadget)
  --vm <id>                   Choose a VM instead of the default
  --session <id>              Use a side chat (must already exist for chat/watch)
  --json                      Print subscription events as JSON
  --sdk-token-file <path>      Read SDK token for pairing (otherwise hidden prompt)
  --probe                     Pair command: discovery only, no token needed
  --help                      Show this help

In chat: /quit exits. Ctrl+C exits.
Subscription events can include conversations from other Muse clients.
Pairing requires macOS and Xcode Command Line Tools.
`;

function printEvent(event: ChatEvent, seen: Map<string, string>): void {
  const p = event.payload;
  const id = String(p.message_id ?? event.raw.message_id ?? p.id ?? '');
  if (!id) return;
  if (event.event === 'delta.text_append' && typeof p.text === 'string') {
    if (!seen.has(id)) process.stdout.write('\nMuse: ');
    process.stdout.write(p.text);
    seen.set(id, (seen.get(id) ?? '') + p.text);
  } else if (event.event === 'delta.message_done' || event.event === 'message.assistant') {
    if (event.event === 'message.assistant' && p.display_text_ready === false) return;
    const text = typeof p.display_text === 'string' ? p.display_text : typeof p.content === 'string' ? p.content : '';
    const previous = seen.get(id);
    if (previous === undefined) { process.stdout.write(`\nMuse: ${text}\n`); }
    else if (text && text !== previous) {
      process.stdout.write(text.startsWith(previous) ? `${text.slice(previous.length)}\n` : `\nMuse (final): ${text}\n`);
    } else if (event.event === 'delta.message_done') process.stdout.write('\n');
    seen.set(id, text || previous || '');
  }
  if (seen.size > 1000) seen.delete(seen.keys().next().value!);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    credentials: { type: 'string' }, vm: { type: 'string' }, session: { type: 'string' },
    'sdk-token-file': { type: 'string' }, probe: { type: 'boolean' },
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(HELP); return; }
  const sessionId = values.session;
  const command = positionals[0] ?? 'chat';
  if (!['pair', 'unpair', 'vms', 'check', 'chat', 'send', 'watch'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command === 'send' && !positionals.slice(1).join(' ').trim()) throw new Error('Usage: cli send "message"');
  const directory = values.credentials ?? defaultCredentialsDirectory();
  if (command === 'unpair') {
    const removed = await unpair(directory);
    console.log(removed ? 'Local pairing removed.' : 'No local pairing found.');
    console.log('To remove the device from Muse, open Settings > Devices in the phone app.');
    return;
  }
  if (command === 'pair') {
    const { runPairCommand } = await import('./pair-command.js');
    await runPairCommand(directory, values['sdk-token-file'], values.probe);
    return;
  }
  const credentials = await loadCredentials(directory);
  const options = { credentials, vmId: values.vm,
    onCredentials: (next: typeof credentials) => saveCredentials(next, directory) };
  if (command === 'vms') {
    const vms = await new MuseAccount(options).listVMs();
    // Explicit projection: never print VM bearer tokens.
    console.table(vms.map(({ id, name, isDefault }) => ({ id, name, default: isDefault })));
    return;
  }
  const client = await MuseClient.connect(options);
  const controller = new AbortController();
  let closing = false;
  let input: ReturnType<typeof createInterface> | undefined;
  const stop = () => { closing = true; controller.abort(); client.close(); input?.close(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    console.error(`Connected to ${client.vm.name || client.vm.id}.`);
    if (command === 'send') {
      const result = await client.sendMessage(positionals.slice(1).join(' '), { sessionId });
      console.log(`Accepted: ${result.messageId}`);
      return;
    }
    const events = await client.subscribe({ signal: controller.signal, sessionId });
    if (command === 'check') {
      console.log('Noise connection and chat subscription established.');
      events.close();
      return;
    }
    const seen = new Map<string, string>();
    const watching = (async () => {
      try {
        for await (const event of events) {
          if (values.json) console.log(JSON.stringify(event.raw));
          else printEvent(event, seen);
        }
        if (!closing) throw new Error('Muse subscription ended; reconnect to continue.');
      } catch (error) {
        if (!closing) { console.error(error instanceof Error ? error.message : 'Subscription failed'); process.exitCode = 1; stop(); }
      }
    })();
    if (command === 'watch') { await watching; return; }
    input = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    if (sessionId) console.error(`Side chat: ${sessionId}`);
    console.error('Type a message. /quit exits.');
    for await (const line of input) {
      const text = line.trim();
      if (!text) continue;
      if (text === '/quit') break;
      try {
        const ack = await client.sendMessage(text, { sessionId, signal: controller.signal });
        console.error(`Sent: ${ack.messageId}`);
      } catch (error) {
        if (!closing) console.error(error instanceof Error ? error.message : 'Send failed');
      }
    }
    stop();
    await watching;
  } finally {
    stop();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Muse CLI failed');
  process.exitCode = 1;
});
