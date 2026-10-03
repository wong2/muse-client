// Adapted from Meta's muse-gadget-sdk (Apache-2.0). See NOTICE.
import {
  createCipheriv, createDecipheriv, createHash, createHmac,
  createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { MuseProtocolError } from '../errors.js';

const EMPTY = Buffer.alloc(0);
const publicPrefix = Buffer.from('302a300506032b656e032100', 'hex');
const privatePrefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
const hash = (...data: Uint8Array[]) => createHash('sha256').update(Buffer.concat(data)).digest();
const hmac = (key: Uint8Array, data: Uint8Array) => createHmac('sha256', key).update(data).digest();

function hkdf(key: Uint8Array, input: Uint8Array): [Buffer, Buffer] {
  const temp = hmac(key, input);
  const first = hmac(temp, Buffer.from([1]));
  return [first, hmac(temp, Buffer.concat([first, Buffer.from([2])]))];
}

export class CipherState {
  private nonce = 0n;
  private dead = false;
  constructor(private readonly key?: Uint8Array) {}

  private iv(): Buffer {
    if (this.dead || this.nonce >= 9007199254740991n) throw new MuseProtocolError('Noise cipher unavailable');
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(this.nonce++, 4);
    return iv;
  }

  encrypt(data: Uint8Array, ad: Uint8Array = EMPTY): Buffer {
    if (this.dead) throw new MuseProtocolError('Noise cipher unavailable');
    if (!this.key) return Buffer.from(data);
    try {
      const cipher = createCipheriv('aes-256-gcm', this.key, this.iv());
      cipher.setAAD(ad);
      return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
    } catch (error) { this.dead = true; throw error; }
  }

  decrypt(data: Uint8Array, ad: Uint8Array = EMPTY): Buffer {
    if (this.dead) throw new MuseProtocolError('Noise cipher unavailable');
    if (!this.key) return Buffer.from(data);
    try {
      if (data.length < 16) throw new Error('Missing authentication tag');
      const cipher = createDecipheriv('aes-256-gcm', this.key, this.iv());
      cipher.setAAD(ad);
      cipher.setAuthTag(data.subarray(-16));
      return Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]);
    } catch {
      this.dead = true;
      throw new MuseProtocolError('Noise authentication failed');
    }
  }
}

function keyPair(raw?: Uint8Array): { privateKey: KeyObject; publicKey: Buffer } {
  const privateKey = raw
    ? createPrivateKey({ key: Buffer.concat([privatePrefix, raw]), type: 'pkcs8', format: 'der' })
    : generateKeyPairSync('x25519').privateKey;
  return { privateKey, publicKey: createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32) };
}

function dh(privateKey: KeyObject, raw: Uint8Array): Buffer {
  if (raw.length !== 32) throw new MuseProtocolError('Invalid X25519 key');
  const publicKey = createPublicKey({ key: Buffer.concat([publicPrefix, raw]), type: 'spki', format: 'der' });
  // OpenSSL rejects low-order points / all-zero shared secrets.
  return diffieHellman({ privateKey, publicKey });
}

export class NoiseInitiator {
  private h: Buffer = Buffer.alloc(32);
  private ck: Buffer;
  private cipher = new CipherState();
  private ephemeral?: ReturnType<typeof keyPair>;
  private remoteEphemeral?: Buffer;
  private phase: 'new' | 'message1' | 'message2' | 'done' | 'dead' = 'new';

  constructor(private readonly fixedKeys?: { ephemeral: Uint8Array; static: Uint8Array }) {
    this.h.write('Noise_XX_25519_AESGCM_SHA256');
    this.ck = this.h;
    this.mixHash(EMPTY);
  }
  private mixHash(data: Uint8Array): void { this.h = hash(this.h, data); }
  private mixKey(data: Uint8Array): void {
    const [ck, key] = hkdf(this.ck, data);
    this.ck = ck;
    this.cipher = new CipherState(key);
  }
  private encrypt(data: Uint8Array): Buffer {
    const encrypted = this.cipher.encrypt(data, this.h);
    this.mixHash(encrypted);
    return encrypted;
  }
  private decrypt(data: Uint8Array): Buffer {
    const plain = this.cipher.decrypt(data, this.h);
    this.mixHash(data);
    return plain;
  }
  message1(): Buffer {
    if (this.phase !== 'new') throw new MuseProtocolError('Invalid handshake state');
    this.ephemeral = keyPair(this.fixedKeys?.ephemeral);
    this.mixHash(this.ephemeral.publicKey);
    this.encrypt(EMPTY);
    this.phase = 'message1';
    return this.ephemeral.publicKey;
  }
  receiveMessage2(message: Buffer): void {
    if (this.phase !== 'message1') throw new MuseProtocolError('Invalid handshake state');
    this.phase = 'dead';
    if (message.length < 96) throw new MuseProtocolError('Noise message 2 too short');
    this.remoteEphemeral = message.subarray(0, 32);
    this.mixHash(this.remoteEphemeral);
    this.mixKey(dh(this.ephemeral!.privateKey, this.remoteEphemeral));
    const remoteStatic = this.decrypt(message.subarray(32, 80));
    this.mixKey(dh(this.ephemeral!.privateKey, remoteStatic));
    this.decrypt(message.subarray(80));
    this.phase = 'message2';
  }
  finish(): { message: Buffer; send: CipherState; receive: CipherState } {
    if (this.phase !== 'message2') throw new MuseProtocolError('Invalid handshake state');
    this.phase = 'dead';
    const local = keyPair(this.fixedKeys?.static);
    const encryptedStatic = this.encrypt(local.publicKey);
    this.mixKey(dh(local.privateKey, this.remoteEphemeral!));
    const message = Buffer.concat([encryptedStatic, this.encrypt(EMPTY)]);
    const [send, receive] = hkdf(this.ck, EMPTY);
    this.ck = this.h = Buffer.alloc(32);
    this.ephemeral = undefined;
    this.remoteEphemeral = undefined;
    this.phase = 'done';
    return { message, send: new CipherState(send), receive: new CipherState(receive) };
  }
}
