import { decodeAndroidPhoto } from './platform';
import { decodeWebPhoto } from './web-photo';

export type LocalPhoto = { id: string; jpeg: Blob; sha256: string };

function stripMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('invalid_jpeg');
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('invalid_jpeg');
    const marker = bytes[offset + 1];
    if (marker === 0xda) {
      parts.push(bytes.subarray(offset));
      break;
    }
    if (marker === 0xd9) { parts.push(bytes.subarray(offset, offset + 2)); break; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(offset, offset + 2)); offset += 2; continue;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + length + 2 > bytes.length) throw new Error('invalid_jpeg');
    if (!((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe)) {
      parts.push(bytes.subarray(offset, offset + length + 2));
    }
    offset += length + 2;
  }
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const clean = new Uint8Array(size);
  let position = 0;
  for (const part of parts) { clean.set(part, position); position += part.length; }
  return clean;
}

export async function photoFromImage(source: CanvasImageSource, width: number, height: number): Promise<LocalPhoto> {
  const scale = Math.min(1, 2048 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas_unavailable');
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const encoded = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob =>
    blob ? resolve(blob) : reject(new Error('jpeg_encode_failed')), 'image/jpeg', 0.8));
  return photoFromJpeg(encoded);
}

async function photoFromJpeg(encoded: Blob): Promise<LocalPhoto> {
  const clean = stripMetadata(new Uint8Array(await encoded.arrayBuffer()));
  const bytes = new Uint8Array(new ArrayBuffer(clean.length));
  bytes.set(clean);
  const jpeg = new Blob([bytes.buffer], { type: 'image/jpeg' });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await jpeg.arrayBuffer()));
  return { id: crypto.randomUUID(), jpeg, sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') };
}

export async function photoFromFile(file: File): Promise<LocalPhoto> {
  const nativeJpeg = await decodeAndroidPhoto(file);
  if (nativeJpeg) return photoFromJpeg(nativeJpeg);
  const bitmap = await decodeWebPhoto(file);
  try { return await photoFromImage(bitmap, bitmap.width, bitmap.height); }
  finally { bitmap.close(); }
}
