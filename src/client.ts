import { MuseAccount, object, requiredString } from './api.js';
import type { AccountOptions, MuseVM } from './api.js';
import { NoiseConnection } from './connection.js';
import { MuseError, MuseHttpError, MuseProtocolError } from './errors.js';
import { decodeChatEvents } from './events.js';
import type { ChatEvent } from './events.js';
export type { ChatEvent } from './events.js';

export interface ChatAcknowledgement {
  messageId: string;
  replyToMessageId?: string;
  raw: Record<string, unknown>;
}
export interface ConnectOptions extends AccountOptions { vmId?: string }
export interface SendOptions { sessionId?: string; signal?: AbortSignal }
export interface SubscribeOptions { sessionId?: string; signal?: AbortSignal }

/** A text-chat connection to a Muse VM. No local shell commands are registered. */
export class MuseClient {
  private constructor(
    private readonly connection: NoiseConnection,
    public readonly vm: Omit<MuseVM, 'authToken'>,
  ) {}

  static async connect(options: ConnectOptions): Promise<MuseClient> {
    const account = new MuseAccount(options);
    for (let attempt = 0; ; attempt++) {
      const vms = await account.listVMs();
      const vm = options.vmId ? vms.find((v) => v.id === options.vmId) : vms.find((v) => v.isDefault) ?? vms[0];
      if (!vm) throw new MuseError(options.vmId ? 'Requested Muse VM was not found' : 'No Muse VM available');
      const host = account.credentials.noiseHost || 'hatch.metaaivm.com';
      // noiseHost is a host[:port], never a URL or path.
      if (/[\s/@?#\\]/.test(host)) throw new MuseError('Invalid Noise host');
      const url = `wss://${host}/v1/noise?vm_id=${encodeURIComponent(vm.id)}`;
      try {
        const connection = await NoiseConnection.connect(url, vm.authToken);
        const { authToken: _, ...publicVM } = vm;
        return new MuseClient(connection, publicVM);
      } catch (error) {
        // Edge credentials can expire separately from the device token.
        if (attempt === 0 && error instanceof MuseHttpError && [401, 403].includes(error.status)) continue;
        throw error;
      }
    }
  }

  async sendMessage(message: string, options: SendOptions = {}): Promise<ChatAcknowledgement> {
    if (!message.trim()) throw new MuseError('Message must not be empty');
    const timeout = AbortSignal.timeout(60000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const response = await this.connection.open('/chat/stream', {
      message, output_modality: 'text', ...(options.sessionId ? { session_id: options.sessionId } : {}),
    }, { signal });
    try {
      if (response.status < 200 || response.status >= 300) throw new MuseHttpError(response.status, '/chat/stream');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new MuseProtocolError('Chat acknowledgement exceeds size limit');
        chunks.push(chunk);
      }
      const raw = object(JSON.parse(Buffer.concat(chunks).toString()));
      const result = object(raw.result ?? raw);
      return { messageId: requiredString(result.message_id, 'message acknowledgement ID'),
        replyToMessageId: typeof result.reply_to_message_id === 'string' ? result.reply_to_message_id : undefined, raw };
    } finally { response.close(); }
  }

  /** Opens the subscription before resolving; call this before sendMessage().
   * Events may include activity from other clients. This is not a per-turn stream.
   */
  async subscribe(options: SubscribeOptions = {}): Promise<AsyncIterable<ChatEvent> & { close(): void }> {
    const response = await this.connection.open('/chat/subscribe', options.sessionId ? { session_id: options.sessionId } : {}, options);
    if (response.status < 200 || response.status >= 300) {
      response.close();
      throw new MuseHttpError(response.status, '/chat/subscribe');
    }
    let consumed = false;
    return {
      close: response.close,
      [Symbol.asyncIterator]: async function* () {
        if (consumed) throw new MuseError('Subscription supports one consumer');
        consumed = true;
        try {
          yield* decodeChatEvents(response.body);
        } finally { response.close(); }
      },
    };
  }

  close(): void { this.connection.close(); }
  [Symbol.dispose](): void { this.close(); }
}
