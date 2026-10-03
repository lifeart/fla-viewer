import pako from 'pako';

export interface SyntheticHumptyBitmapFixture {
  dat: Uint8Array;
  pixelData: Uint8Array;
  width: number;
  height: number;
}

function writeUint16LE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32LE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function createHeader(width: number, height: number, variant: 0 | 1): Uint8Array {
  const header = new Uint8Array(26);
  header[0] = 0x03;
  header[1] = 0x05;
  writeUint16LE(header, 2, width * 4);
  writeUint16LE(header, 4, width);
  writeUint16LE(header, 6, height);
  writeUint32LE(header, 12, width * 20);
  writeUint32LE(header, 20, height * 20);
  header[24] = 1;
  header[25] = variant;
  return header;
}

function createSyntheticPixelPlane(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    pixels[index * 4] = 0xff; // alpha
    pixels[index * 4 + 1] = (index * 53 + 17) & 0xff; // red
    pixels[index * 4 + 2] = (index * 29 + 31) & 0xff; // green
    pixels[index * 4 + 3] = (index * 11 + 47) & 0xff; // blue
  }
  if (width * height > 1) {
    // Semi-transparent premultiplied A,R,G,B sample. The parser should decode
    // this to RGBA [64, 96, 128, 128].
    pixels[4] = 129;
    pixels[5] = 32;
    pixels[6] = 48;
    pixels[7] = 64;
  }
  return pixels;
}

/**
 * Synthetic equivalent of Humpty's variant-0 bitmap records: the bytes after
 * the 26-byte header are an exact-size, uncompressed A,R,G,B pixel plane.
 * No proprietary artwork or source bytes are included.
 */
export function createHumptyCompatibleRawBitmapFixture(
  width = 7,
  height = 5,
): SyntheticHumptyBitmapFixture {
  const header = createHeader(width, height, 0);
  const pixelData = createSyntheticPixelPlane(width, height);
  const dat = new Uint8Array(header.length + pixelData.length);
  dat.set(header);
  dat.set(pixelData, header.length);
  return { dat, pixelData, width, height };
}

/**
 * Synthetic equivalent of Humpty's variant-1 records: zlib header plus a raw
 * deflate stream split into repeated UI16-length chunks and a zero terminator.
 * A tiny chunk size deliberately exercises concatenation of many records.
 * `trailingPadding` appends that many zero bytes after the pixel plane inside
 * the deflate stream (padding the decoder must drop, not reject).
 */
export function createHumptyCompatibleChunkedBitmapFixture(
  width = 11,
  height = 9,
  chunkSize = 17,
  trailingPadding = 0,
): SyntheticHumptyBitmapFixture {
  const header = createHeader(width, height, 1);
  const pixelData = createSyntheticPixelPlane(width, height);
  const plane = new Uint8Array(pixelData.length + trailingPadding);
  plane.set(pixelData);
  const compressed = pako.deflateRaw(plane);
  const stream = new Uint8Array(compressed.length + 2);
  stream[0] = 0x78;
  stream[1] = 0x01;
  stream.set(compressed, 2);

  const chunkCount = Math.ceil(stream.length / chunkSize);
  const dat = new Uint8Array(header.length + stream.length + chunkCount * 2 + 2);
  dat.set(header);
  let readOffset = 0;
  let writeOffset = header.length;
  while (readOffset < stream.length) {
    const length = Math.min(chunkSize, stream.length - readOffset);
    writeUint16LE(dat, writeOffset, length);
    writeOffset += 2;
    dat.set(stream.subarray(readOffset, readOffset + length), writeOffset);
    readOffset += length;
    writeOffset += length;
  }
  writeUint16LE(dat, writeOffset, 0);
  return { dat, pixelData, width, height };
}
