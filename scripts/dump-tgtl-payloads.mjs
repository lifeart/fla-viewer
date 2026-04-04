import JSZip from 'jszip';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const [elementName, drawingName] = args;

if (!elementName || !drawingName) {
  console.error('Usage: node scripts/dump-tgtl-payloads.mjs <elementName> <drawingName>');
  process.exit(1);
}

const zip = await JSZip.loadAsync(readFileSync('./sample/toon/CH_Anna_rig_football_suit_V001_V07.zip'));
const base = `CH_Anna_rig_football_suit_V001_V07/elements/${elementName}`;
const tvgFile = zip.file(`${base}/${drawingName}.tvg`);
if (!tvgFile) {
  console.error(`Missing TVG: ${base}/${drawingName}.tvg`);
  process.exit(1);
}

const data = new Uint8Array(await tvgFile.async('arraybuffer'));

function readTag(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function readU32LE(bytes, offset) {
  return bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24);
}

function sanitize(value) {
  return value
    .replace(/\0/g, '')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .trim();
}

function extractLengthPrefixedUTF16Strings(payload) {
  const strings = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let offset = 0; offset <= payload.length - 4; offset++) {
    const charLen = view.getUint16(offset, true);
    if (charLen <= 0 || charLen > 96) continue;
    for (const start of [offset + 2, offset + 4, offset + 6, offset + 8]) {
      const end = start + charLen * 2;
      if (end > payload.length) continue;
      const slice = payload.slice(start, end);
      const decodedLe = sanitize(new TextDecoder('utf-16le').decode(slice));
      const swapped = new Uint8Array(slice.length);
      for (let i = 0; i < slice.length - 1; i += 2) {
        swapped[i] = slice[i + 1];
        swapped[i + 1] = slice[i];
      }
      const decodedBe = sanitize(new TextDecoder('utf-16le').decode(swapped));
      for (const decoded of [decodedLe, decodedBe]) {
        if (!decoded) continue;
        if (strings.some(entry => entry.offset === offset && entry.value === decoded)) continue;
        strings.push({ offset, value: decoded });
      }
    }
  }
  return strings;
}

let tgndOffset = -1;
for (let i = 0; i <= data.length - 4; i++) {
  if (readTag(data, i) === 'TGND') {
    tgndOffset = i;
    break;
  }
}
const scanStart = tgndOffset >= 0 ? tgndOffset + 8 : 0;
const scanEnd = tgndOffset >= 0 ? Math.min(data.length, scanStart + readU32LE(data, tgndOffset + 4)) : data.length;

const rows = [];
for (let offset = scanStart; offset + 8 <= scanEnd; ) {
  if (readTag(data, offset) !== 'TGTL') {
    offset += 1;
    continue;
  }
  const length = readU32LE(data, offset + 4);
  const payloadStart = offset + 8;
  const payloadEnd = payloadStart + length;
  if (payloadEnd > scanEnd || length <= 0) {
    offset += 1;
    continue;
  }
  const payload = data.slice(payloadStart, payloadEnd);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const strings = extractLengthPrefixedUTF16Strings(payload);
  const markers = [];
  for (let marker = 0; marker <= payload.length - 32; marker += 8) {
    const a = view.getFloat64(marker, true);
    const b = view.getFloat64(marker + 24, true);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (Math.abs(a - 2500) > 0.01 || Math.abs(b - 2500) > 0.01) continue;
    const window = [];
    for (let rel = -10; rel <= 4; rel++) {
      const pos = marker + rel * 8;
      if (pos < 0 || pos + 8 > payload.length) continue;
      window.push({
        rel,
        offset: pos,
        value: view.getFloat64(pos, true),
      });
    }
    markers.push({ marker, window });
  }
  rows.push({
    offset,
    length,
    strings,
    markers,
  });
  offset = payloadEnd;
}

console.log(JSON.stringify(rows, null, 2));
