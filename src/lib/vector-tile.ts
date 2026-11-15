/** A Mapbox Vector Tile 2.1 decoder, just enough to draw: layer names, extents, feature tags, types and
 * geometry. https://github.com/mapbox/vector-tile-spec/tree/master/2.1 */

export type Value = string | number | boolean;
export type Geometry = [number, number][][];
/** 1 point, 2 line, 3 polygon; 0 is unknown. A polygon's rings come exterior first, each closed. */
export type Feature = { type: number; properties: Record<string, Value>; geometry: Geometry };
export type Layer = { extent: number; features: Feature[] };

class Reader {
  position = 0;
  constructor(private bytes: Uint8Array, readonly end = bytes.length) {}
  get done() { return this.position >= this.end; }
  varint() {
    let result = 0;
    for (let shift = 0; ; shift += 7) {
      if (this.position >= this.end || shift > 63) throw new Error('Corrupt vector tile');
      const byte = this.bytes[this.position++];
      // Past 32 bits shifts overflow, so multiply instead; tile values never need more than 53 bits.
      result += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return result;
    }
  }
  /** The next field's number and wire type. */
  key() { const value = this.varint(); return [Math.floor(value / 8), value & 7] as const; }
  sub() {
    const length = this.varint();
    const end = this.position + length;
    if (end > this.end) throw new Error('Corrupt vector tile');
    const reader = new Reader(this.bytes, end);
    reader.position = this.position;
    this.position = end;
    return reader;
  }
  string() { const reader = this.sub(); return new TextDecoder().decode(this.bytes.subarray(reader.position, reader.end)); }
  fixed(size: 4 | 8) {
    if (this.position + size > this.end) throw new Error('Corrupt vector tile');
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.position, size);
    this.position += size;
    return size === 4 ? view.getFloat32(0, true) : view.getFloat64(0, true);
  }
  packed() { const reader = this.sub(); const values: number[] = []; while (!reader.done) values.push(reader.varint()); return values; }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.fixed(8);
    else if (wire === 2) this.sub();
    else if (wire === 5) this.fixed(4);
    else throw new Error('Corrupt vector tile');
  }
}

export const zigzag = (value: number) => value % 2 ? -(value + 1) / 2 : value / 2;

/** Geometry commands to rings or lines. MoveTo is 1, LineTo 2, ClosePath 7; parameters are zigzag deltas. */
export function decodeGeometry(commands: number[]): Geometry {
  const parts: Geometry = [];
  let x = 0, y = 0, index = 0;
  let current: [number, number][] | undefined;
  while (index < commands.length) {
    const command = commands[index] & 7;
    const count = Math.floor(commands[index++] / 8);
    for (let step = 0; step < count; step++) {
      if (command === 7) { if (current?.length) current.push(current[0]); continue; }
      if (command !== 1 && command !== 2 || index + 1 >= commands.length) throw new Error('Corrupt vector tile');
      x += zigzag(commands[index++]);
      y += zigzag(commands[index++]);
      if (command === 1) parts.push(current = []);
      if (!current) throw new Error('Corrupt vector tile');
      current.push([x, y]);
    }
  }
  return parts;
}

function value(reader: Reader): Value | undefined {
  let found: Value | undefined;
  while (!reader.done) {
    const [field, wire] = reader.key();
    if (field === 1 && wire === 2) found = reader.string();
    else if (field === 2 && wire === 5) found = reader.fixed(4);
    else if (field === 3 && wire === 1) found = reader.fixed(8);
    else if ((field === 4 || field === 5) && wire === 0) found = reader.varint();
    else if (field === 6 && wire === 0) found = zigzag(reader.varint());
    else if (field === 7 && wire === 0) found = reader.varint() !== 0;
    else reader.skip(wire);
  }
  return found;
}

function layer(reader: Reader, wanted: readonly string[]) {
  let name = '', extent = 4096;
  const keys: string[] = [], values: (Value | undefined)[] = [], raw: Reader[] = [];
  while (!reader.done) {
    const [field, wire] = reader.key();
    if (field === 1 && wire === 2) {
      name = reader.string();
      // Layers not drawn stop here, so buildings and house numbers cost no decoding.
      if (!wanted.includes(name)) return undefined;
    } else if (field === 2 && wire === 2) raw.push(reader.sub());
    else if (field === 3 && wire === 2) keys.push(reader.string());
    else if (field === 4 && wire === 2) values.push(value(reader.sub()));
    else if (field === 5 && wire === 0) extent = reader.varint();
    else reader.skip(wire);
  }
  // Features read last, since a layer may list its keys and values after them.
  const features = raw.map(feature => {
    let type = 0, tags: number[] = [], geometry: Geometry = [];
    while (!feature.done) {
      const [field, wire] = feature.key();
      if (field === 2 && wire === 2) tags = feature.packed();
      else if (field === 3 && wire === 0) type = feature.varint();
      else if (field === 4 && wire === 2) geometry = decodeGeometry(feature.packed());
      else feature.skip(wire);
    }
    const properties: Record<string, Value> = {};
    for (let index = 0; index + 1 < tags.length; index += 2) {
      const key = keys[tags[index]], found = values[tags[index + 1]];
      if (key === undefined || found === undefined) throw new Error('Corrupt vector tile');
      properties[key] = found;
    }
    return { type, properties, geometry };
  });
  return wanted.includes(name) ? { name, layer: { extent, features } } : undefined;
}

/** Decodes the named layers of a tile; others are skipped unread. Throws on a corrupt tile. */
export function decodeTile(bytes: Uint8Array, wanted: readonly string[]) {
  const reader = new Reader(bytes);
  const layers: Record<string, Layer> = {};
  while (!reader.done) {
    const [field, wire] = reader.key();
    if (field !== 3 || wire !== 2) { reader.skip(wire); continue; }
    const found = layer(reader.sub(), wanted);
    if (found) layers[found.name] = found.layer;
  }
  return layers;
}
