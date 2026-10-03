# muse-ts

Unofficial TypeScript SDK for text chat with your Muse, using the open-source
[Muse Gadget SDK](https://github.com/facebookincubator/muse-gadget-sdk) protocol.

The SDK implements account/VM lookup, device-token refresh, the Noise XX
WebSocket transport, sending messages, streaming chat subscriptions, and macOS
Bluetooth pairing.

## CLI example

```sh
bun install
bun run build
bun run cli pair
bun run cli check
bun run cli chat
```

`pair` performs first-time authorization using the Muse phone app. If this Mac
is already paired, it preserves your credentials and tells you to run `chat`.
Pairing credentials are stored outside the repository:

- macOS: `~/Library/Application Support/MuseGadgetPair/`
- Linux: `/var/lib/musegadget/`
- Override: `--credentials /path/to/directory`

The directory contains `identity.json`, `pairing.json`, and `sdk_token`.
Tokens are never printed by the CLI.

### First-time pairing on macOS

1. Install Xcode Command Line Tools if needed: `xcode-select --install`.
2. Run `bun run cli pair`. If no token is saved, paste your personal
   [SDK token](https://gadgets.muse.ai/settings/sdk-tokens) into the hidden prompt.
3. Allow Bluetooth access when macOS asks. In the Muse phone app enable
   Settings > Devices > Developer mode, then Add Device.
4. Select the printed `MuseGadgetXXXXXX` name and confirm the community-device
   prompt. Select **Use current connection** when asked for Wi-Fi; the Mac's
   network settings are not changed.
5. Wait for `Paired successfully`, then run `bun run cli chat`.

The SDK compiles and caches its native transport under
`~/Library/Caches/muse-ts/bluetooth/`. Credential files use mode `0600` and new state
directories use `0700`. The app advertises only while this command is running;
the setup window closes after ten minutes. Ctrl+C cancels and closes the helper.

```sh
# Discovery test only: no token or account changes.
bun run cli pair --probe

# Read a token from a private file instead of prompting.
bun run cli pair --sdk-token-file /path/to/sdk_token

# Create a separate gadget without overwriting an existing pairing.
bun run cli pair --credentials "$HOME/Library/Application Support/MyOtherMuseGadget"
```

Each credentials directory permits one pairing process at a time. If the process
is forcibly killed, a `pair.lock` file may remain. Remove that file only after
confirming no pairing process is still using the directory. Community pairing
does not use a manufacturer certificate; complete authorization with your own
phone in a trusted environment.

Programmatic pairing is available from a separate entry point:

```ts
import { pairMacOS } from 'muse-ts/pairing';

const credentials = await pairMacOS({
  sdkToken: process.env.MUSE_SDK_TOKEN, // Or omit to read the saved sdk_token file.
  onProgress: console.log,
});
// pairMacOS saves the result locally as well as returning it.
```

```sh
bun run cli vms
bun run cli chat --vm YOUR_VM_ID
bun run cli chat --session YOUR_SESSION_ID
bun run cli send "Hello Muse"
bun run cli watch --json
```

`chat` subscribes before accepting input, displays reply text as it arrives, and
exits with `/quit` or Ctrl+C. Pass an existing side-chat ID with `--session` to
continue it. `send` prints the message acknowledgement,
not an assistant reply. `watch --json` prints full events, which can include
private conversation content; redirect output only to a destination you trust.

`check` verifies a real Noise connection and a successful chat subscription
without sending a message. It does not prove that a model response will arrive.

## SDK usage

The package is local and has not been published. After building, import from
`./dist/index.mjs`, or link/install this folder into your application and import
from `muse-ts`.

```ts
import { MuseClient } from 'muse-ts';
import { loadCredentials, saveCredentials } from 'muse-ts/credentials';

const client = await MuseClient.connect({
  credentials: await loadCredentials(),
  onCredentials: saveCredentials,
});

try {
  // Resolves only after the server accepts the subscription.
  const events = await client.subscribe();
  const reading = (async () => {
    for await (const event of events) {
      if (event.event === 'delta.text_append') {
        process.stdout.write(String(event.payload.text ?? ''));
      }
    }
  })();
  // Attach a rejection handler immediately; the subscription can disconnect.
  reading.catch(() => {});

  const ack = await client.sendMessage('Hello!');
  console.log('Accepted message:', ack.messageId);
  await reading; // Long-lived; close/abort the subscription when your UI exits.
} finally {
  client.close();
}
```

For an existing side chat, pass the **same** `sessionId` to `subscribe` and `sendMessage`.
Sending with a new session ID creates a side chat, but subscribing before that
session exists returns HTTP 404. The SDK does not silently create a session or
send a message to work around this. Subscribe to an existing session before
sending the next message; this API does not promise replay of earlier replies.
The default subscription is for the main chat; it does not deliver side-chat
reply text. The subscription is a session event feed, not a request-scoped
completion iterator. Activity from another client in that session can appear.
Use `reply_to_message_id` / `parent_message_id` in event payloads and the returned
acknowledgement to correlate replies when needed.

```ts
import { MuseAccount } from 'muse-ts';

const account = new MuseAccount({
  credentials: {
    accessToken: '...',
    refreshToken: '...',
    deviceId: 'homelink-123abc',
    sdkToken: 'mgst_...', // Optional for existing credentials; supplied on refresh.
  },
  onCredentials: async (next) => {
    // Persist next.accessToken and next.refreshToken in your own secure store.
  },
});

const vms = await account.listVMs(); // Includes sensitive per-VM authToken values.
```

## API and behavior

| API | Purpose |
| --- | --- |
| `MuseAccount.listVMs()` | Fetch VMs; refresh on an expired device token |
| `MuseAccount.refresh()` | Rotate tokens and await `onCredentials` persistence |
| `MuseClient.connect({ credentials, vmId?, onCredentials? })` | Select a VM and establish Noise |
| `client.sendMessage(text, { sessionId?, signal? })` | Send text and receive its acknowledgement |
| `client.subscribe({ sessionId?, signal? })` | Receive an async iterable of chat events with `close()` |
| `client.close()` | Close the socket and reject pending operations |
| `loadCredentials(directory?)` / `saveCredentials(credentials, directory?)` | Read/update existing gadget pairing files |
| `pairMacOS({ directory?, sdkToken?, probe?, signal?, onProgress? })` | Authorize this Mac through the phone app; probe returns undefined |
| `buildPairingHelper()` | Compile the bundled Swift transport without starting Bluetooth |

- Uses `Noise_XX_25519_AESGCM_SHA256` over a TLS WebSocket. TLS and the per-VM
  bearer authenticate the gateway; the ephemeral Noise handshake does not pin a
  long-lived server identity.
- Rotates an aged device token at VM lookup (three-hour threshold when `savedAt`
  is known), or once on HTTP 401. Refreshes are coalesced within one account
  instance. Always persist rotated tokens; avoid concurrent processes sharing
  the same refresh-token file. Long-running sockets use their established session;
  refreshing happens when making a new connection, not on a background timer.
- Re-fetches VM credentials once if the WebSocket upgrade returns 401/403.
  Does not automatically reconnect or resend messages, avoiding duplicate turns.
- `sendMessage` has a 60-second timeout; connections and response headers have
  20-second timeouts. Subscriptions stay open until closed, aborted, or disconnected.
- There is no reliable end-of-turn event in the inspected protocol. Individual
  assistant messages have completion events; a turn can contain several messages.
- No local shell commands, file access tools, or device control commands are
  registered with Muse. This SDK connects directly to the chat endpoints.
- Bluetooth pairing currently supports macOS only; chat also runs on Linux.
- Audio, attachments, history listing, and independent account login
  are outside the current implementation.

## Development and validation

```sh
bun run typecheck
bun run test
bun run build
```

Offline tests cover independent Python-generated Noise vectors, tampering and
replay rejection, protobuf/chunk validation, token refresh, and private credential
storage. Pairing tests match the upstream public v5 vectors and simulate the
full encrypted phone flow, rejected credentials, storage failure, replay,
expiry, and disconnect during verification. The optional live **local** interoperability test uses the upstream
Python responder; it needs no Muse account and makes no external connections:

```sh
MUSE_GADGET_SDK=/path/to/muse-gadget-sdk \
MUSE_TEST_PYTHON=/path/to/python-with-cryptography-and-websockets \
bun run test
```

Without those variables, that one test is skipped.

Live validation on 2026-10-03: imported the macOS pairing credentials, connected
to a real Muse VM, and received the requested test replies in both the main chat
and a side chat. A new side-chat subscription was observed to return 404 until
the first message created that session. These are observed results, not a
promise of future endpoint stability.

Pairing has passed offline protocol tests and macOS advertising verification.
The complete phone-to-credential flow still needs real-device validation.

## License and service access

Apache-2.0. Portions of the protocol implementation are adapted from Meta's
Muse Gadget SDK; see `NOTICE` and `LICENSE`. This project is unofficial. Muse
service access is governed separately by the
[Gadget SDK Terms](https://gadgets.muse.ai/sdk-terms), and these endpoints are not
a guaranteed stable public developer API.
