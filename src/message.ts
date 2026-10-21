import { MAX_REQUEST_BODY_BYTES } from './connection.js';
import { MuseError } from './errors.js';

export interface ImageAttachment {
  /** Raw image bytes (Buffer is also accepted), not base64 or a URL. */
  data: Uint8Array;
  /** The image's media type, e.g. image/jpeg or image/png. */
  mimeType: string;
  filename: string;
}

/** A File supplies its own name, media type and bytes. */
export type ImageInput = ImageAttachment | File;

export interface MessageOptions {
  /** Images sent together with the text in a single Muse turn. */
  images?: readonly ImageInput[];
  sessionId?: string;
}

function fileMimeType(file: File): string {
  if (file.type) return file.type;
  if (!file.name.includes('.')) return '';
  const types: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp',
    heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  };
  return types[file.name.split('.').at(-1)!.toLowerCase()] ?? '';
}

export function validateMessage(message: string, images: readonly ImageInput[] = []): void {
  if (!Array.isArray(images)) throw new MuseError('Images must be an array');
  if (!message.trim() && !images.length) throw new MuseError('Message must not be empty');
  let encodedBytes = 0;
  for (const image of images) {
    const file = image instanceof File;
    if (file ? !image.size : !image || !(image.data instanceof Uint8Array) || !image.data.byteLength) {
      throw new MuseError('Image data must be a non-empty Uint8Array or File');
    }
    const filename = file ? image.name : image.filename;
    const mimeType = file ? fileMimeType(image) : image.mimeType;
    if (typeof filename !== 'string' || !filename.trim()) throw new MuseError('Image filename must not be empty');
    if (typeof mimeType !== 'string' || !/^image\/[a-z0-9!#$&^_.+\-]+$/i.test(mimeType)) {
      throw new MuseError('Image MIME type must be an image/* media type; set File.type if it cannot be inferred');
    }
    encodedBytes += 4 * Math.ceil((file ? image.size : image.data.byteLength) / 3);
    if (encodedBytes > MAX_REQUEST_BODY_BYTES) throw new MuseError('Muse request body is too large; resize or compress images');
  }
}

export async function chatRequest(message: string, options: MessageOptions) {
  validateMessage(message, options.images);
  const files = await Promise.all((options.images ?? []).map(async (image) => ({
    type: 'file',
    mime_type: image instanceof File ? fileMimeType(image) : image.mimeType,
    filename: image instanceof File ? image.name : image.filename,
    data_base64: (image instanceof File ? Buffer.from(await image.arrayBuffer()) : Buffer.from(image.data)).toString('base64'),
  })));
  const body = {
    message, output_modality: 'text',
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
    ...(files.length ? {
      // Muse ignores the top-level message when file items are present.
      items: [
        ...(message.trim() ? [{ type: 'text', text: message }] : []),
        ...files,
      ],
    } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_REQUEST_BODY_BYTES) {
    throw new MuseError('Muse request body is too large; shorten the text or resize images');
  }
  return body;
}
