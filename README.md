# muse-client

Unofficial TypeScript SDK for chatting with [Muse](https://muse.ai), based on the
[Muse Gadget SDK](https://github.com/facebookincubator/muse-gadget-sdk) protocol.
Supports streaming text chat, VM lookup, token refresh, and macOS Bluetooth pairing.

Requires Node.js 22.18 or later. Pairing supports macOS; chat also runs on Linux.

## Install

```sh
npm install muse-client
```

## Pair with Muse

Pairing requires Xcode Command Line Tools (`xcode-select --install`) and a personal
[SDK token](https://gadgets.muse.ai/settings/sdk-tokens).

From the project directory:

```sh
bun install
bun run cli pair
```

1. Paste your SDK token when prompted and allow Bluetooth access.
2. In the Muse phone app, enable **Settings > Devices > Developer mode**, then
   choose **Add Device**.
3. Select the printed `MuseGadgetXXXXXX` name, confirm, and choose
   **Use current connection** for Wi-Fi.
4. Wait for `Paired successfully`.

The phone must be able to reach `hatch-api.meta.ai` to obtain device credentials.
If pairing fails after selecting a network, check the phone's network or proxy rules.

For pairing from your own application:

```ts
import { pairMacOS } from 'muse-client/pairing';

const credentials = await pairMacOS({
  sdkToken: process.env.MUSE_SDK_TOKEN,
  onProgress: console.log,
});
```

Pairing saves credentials locally. The default directory is
`~/Library/Application Support/MuseGadgetPair/` on macOS and `/var/lib/musegadget/`
on Linux. Use `--credentials <directory>` in the CLI or `directory` in `pairMacOS`
to choose another location. Existing pairings are preserved.

The SDK token is associated with a device **when it pairs**. After changing that
token, or revoking the token used for pairing, run `bun run cli unpair` followed by
`bun run cli pair` with the new token. Refreshing device credentials does not
change this association. New pairings save `sdk_token_hint` (the first 12
characters); the CLI warns when the configured token differs. Older pairing files
without a hint remain usable, but their original SDK token cannot be determined.

## CLI example

The CLI runs from the repository:

```sh
bun run cli chat                 # Interactive chat; /quit or Ctrl+C to exit
bun run cli vms                  # List Muse VMs
bun run cli check                # Check the connection without sending a message
bun run cli send "Hello Muse"    # Send a message and print its acknowledgement
bun run cli watch --json         # Stream chat events
bun run cli unpair               # Remove local pairing credentials
```

Use `--vm <id>` to choose a VM, `--session <id>` for an existing side chat, and
`--help` for all options.

Interactive `chat` waits for each request's replies before sending the next input.
`chat --json` prints typed turn events; `watch --json` prints raw subscription
events.

Before running `unpair`, stop any chat or pairing process. It preserves the device
identity and SDK token. To remove the device association from Muse, use
**Settings > Devices** in the phone app.

## SDK usage

After pairing:

```ts
import { MuseClient } from 'muse-client';
import { loadCredentials, saveCredentials } from 'muse-client/credentials';

const client = await MuseClient.connect({
  credentials: await loadCredentials(),
  onCredentials: saveCredentials,
  onWarning: console.warn,
});

try {
  for await (const event of client.chat('Hello!')) {
    if (event.type === 'reply') {
      // text is the current snapshot, not an append-only delta.
      if (event.done) console.log(event.text);
    } else if (event.type === 'agent-status') {
      console.log(event.activityText ?? event.activityCode);
    }
  }
} finally {
  client.close();
}
```

- `chat()` opens a subscription before sending, associates replies with the
  acknowledgement, and closes its subscription on completion, early loop exit,
  cancellation, or error. Set `signal` to cancel, or `timeoutMs` to change the
  120-second overall deadline.
- Completion waits for all bound replies to finish and the associated task to
  finish, or for three seconds without activity when no busy status remains.
  This quiet-period fallback is a heuristic. Terminal tasks with empty replies
  get a short grace period for reordered text. `task-finished` is a server task
  status event; the iterator ending indicates that the whole turn has settled.
- Shared-chat replies with no provable parent link are omitted by `chat()`. For an
  **existing side chat used exclusively by your application**, pass
  `{ sessionId, ownsChat: true }` to accept parentless replies. The acknowledgement
  must confirm the side chat. Sequential owned turns share a bounded replay
  history on the client; overlapping owned turns in the same chat are rejected.
- A new side chat must be created by sending its first message with
  `sendMessage(message, { sessionId })` before subscribing. `chat()` does not
  create a new side chat.
- Persist refreshed credentials with `onCredentials`. Avoid concurrent processes
  sharing the same credentials. The SDK does not automatically reconnect or resend.

For raw events, use `subscribe()` and `sendMessage()` directly; subscribe before
sending and pass the same `sessionId` to both. Raw subscriptions may include other
clients' activity. A slow consumer exceeding its 4 MiB response buffer fails and
resets only that request, leaving other streams on the connection usable.

For custom event loops, `MuseTurn` exposes the tracking state separately:

```ts
import { MuseTurn } from 'muse-client';

const turn = new MuseTurn({ sessionId });
// Start feeding events before sending. feed() buffers until acknowledge().
// In the subscription reader: handle(turn.feed(event)).
const updates = turn.acknowledge(await client.sendMessage('Hello!', { sessionId }));
// Handle updates, then keep feeding events and checking turn.complete().
// turn.completionDelay() gives the next timer delay; Infinity means wait for events.
```

`feed()` and `acknowledge()` return `TurnEvent[]`. Low-level `Reply` events include
`bound`, so callers can distinguish unlinked shared-chat messages; only bound
replies participate in completion. `replies` is a snapshot map keyed by message
ID. Create a fresh `MuseTurn` for each request. To filter replays in an owned chat,
share a `ReplayScope` between turns and call `turn.retire()` when each turn ends.
Times passed to `complete(now)` use `performance.now()` milliseconds.

## API

| Import | Exports |
| --- | --- |
| `muse-client` | `MuseClient`, `MuseAccount`, `MuseTurn`, `ReplayScope`, `transcriptText` |
| `muse-client/credentials` | `loadCredentials`, `saveCredentials`, `unpair` |
| `muse-client/pairing` | `pairMacOS`, `buildPairingHelper`, `validateSDKToken` |

`MuseClient` provides `connect`, `chat`, `sendMessage`, `subscribe`, and `close`.
`MuseAccount` provides `listVMs` and `refresh`.
Both accept `onWarning` to report an SDK token change since pairing. The warning
does not block chat or trigger a token refresh.

Audio, attachments, history listing, and independent account login are not supported.
The SDK does not expose local shell commands or device controls to Muse.

## Development

```sh
bun run typecheck
bun run test
bun run build
```

The optional upstream interoperability test requires `MUSE_GADGET_SDK` and
`MUSE_TEST_PYTHON`; it is skipped when these are unset.

## License

Apache-2.0; see `LICENSE` and `NOTICE`. This project is unofficial and is not
affiliated with Meta. Muse service access is subject to the
[Gadget SDK Terms](https://gadgets.muse.ai/sdk-terms).
