// Admission limits, not a browser codec scratch-memory guarantee. Keep the full-frame
// fallback within 12 MP even when createImageBitmap resizes only after decoding.
const maxPixels = 12_000_000;
const maxEdge = 8192;
const maxBytes = 20 * 1024 * 1024;
const maxHeaderBytes = 1024 * 1024;

type Bounds = { width: number; height: number; orientation: number };
const invalid = (): never => { throw new Error('unsupported_web_photo'); };

function admitted(width: number, height: number, orientation = 1): Bounds {
  if (!width || !height || width > maxEdge || height > maxEdge || width * height > maxPixels) invalid();
  return { width, height, orientation };
}

function exifOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8) return invalid();
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) return invalid();
  if (view.getUint16(2, little) !== 42) return invalid();
  const offset = view.getUint32(4, little);
  if (offset < 8 || offset + 2 > bytes.length) return invalid();
  const count = view.getUint16(offset, little);
  if (offset + 2 + count * 12 + 4 > bytes.length) return invalid();
  for (let index = 0; index < count; index++) {
    const entry = offset + 2 + index * 12;
    if (view.getUint16(entry, little) !== 0x112) continue;
    if (view.getUint16(entry + 2, little) !== 3 || view.getUint32(entry + 4, little) !== 1) return invalid();
    const orientation = view.getUint16(entry + 8, little);
    if (orientation < 1 || orientation > 8) return invalid();
    return orientation;
  }
  return 1;
}

async function jpegBounds(file: File): Promise<Bounds> {
  // Never load an Image just to discover dimensions: that may allocate the full frame.
  const bytes = new Uint8Array(await file.slice(0, maxHeaderBytes).arrayBuffer());
  let offset = 2;
  let bounds: Bounds | undefined;
  let orientation = 1;
  let hasExif = false;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda) return bounds ? { ...bounds, orientation } : invalid();
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return invalid();
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (bounds || ![0xc0, 0xc2].includes(marker) || length < 8 || bytes[offset + 2] !== 8) return invalid();
      const components = bytes[offset + 7];
      if (![1, 3].includes(components) || length !== 8 + components * 3) return invalid();
      bounds = admitted((bytes[offset + 5] << 8) | bytes[offset + 6], (bytes[offset + 3] << 8) | bytes[offset + 4]);
    }
    if (marker === 0xe1 && bytes[offset + 2] === 69 && bytes[offset + 3] === 120 &&
      bytes[offset + 4] === 105 && bytes[offset + 5] === 102 && bytes[offset + 6] === 0 && bytes[offset + 7] === 0) {
      if (hasExif) return invalid();
      hasExif = true;
      orientation = exifOrientation(bytes.subarray(offset + 8, offset + length));
    }
    offset += length;
  }
  return invalid();
}

async function pngBounds(file: File): Promise<Bounds> {
  const header = new DataView(await file.slice(0, 33).arrayBuffer());
  if (header.byteLength !== 33 || header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452 ||
    header.getUint8(24) !== 8 || ![0, 2, 3, 4, 6].includes(header.getUint8(25)) ||
    header.getUint8(26) !== 0 || header.getUint8(27) !== 0 || header.getUint8(28) > 1) return invalid();
  const bounds = admitted(header.getUint32(16), header.getUint32(20));
  let offset = 33;
  let hasExif = false;
  let hasData = false;
  // Skip compressed data without copying it. Refuse animation and excessive chunk tables.
  for (let chunks = 0; chunks < 1024 && offset + 12 <= file.size; chunks++) {
    const chunk = new DataView(await file.slice(offset, offset + 8).arrayBuffer());
    const length = chunk.getUint32(0);
    const type = chunk.getUint32(4);
    if (offset + length + 12 > file.size || type === 0x6163544c || type === 0x49484452) return invalid();
    if (type === 0x49444154) hasData = true;
    if (type === 0x65584966) {
      if (hasExif || length > 65536) return invalid();
      hasExif = true;
      bounds.orientation = exifOrientation(new Uint8Array(await file.slice(offset + 8, offset + 8 + length).arrayBuffer()));
    }
    offset += length + 12;
    if (type === 0x49454e44) return length === 0 && hasData && offset === file.size ? bounds : invalid();
  }
  return invalid();
}

export async function decodeWebPhoto(file: File): Promise<ImageBitmap> {
  if (!file.size || file.size > maxBytes) return invalid();
  const signature = new DataView(await file.slice(0, 8).arrayBuffer());
  let bounds: Bounds;
  if (signature.byteLength >= 2 && signature.getUint16(0) === 0xffd8) bounds = await jpegBounds(file);
  else if (signature.byteLength === 8 && signature.getUint32(0) === 0x89504e47 && signature.getUint32(4) === 0x0d0a1a0a) bounds = await pngBounds(file);
  else return invalid();
  const rotated = bounds.orientation >= 5;
  const width = rotated ? bounds.height : bounds.width;
  const height = rotated ? bounds.width : bounds.height;
  const scale = Math.min(1, 2048 / Math.max(width, height));
  const expectedWidth = Math.max(1, Math.round(width * scale));
  const expectedHeight = Math.max(1, Math.round(height * scale));
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image',
    resizeWidth: expectedWidth, resizeHeight: expectedHeight, resizeQuality: 'high' });
  if (bitmap.width !== expectedWidth || bitmap.height !== expectedHeight) {
    bitmap.close();
    return invalid();
  }
  return bitmap;
}
