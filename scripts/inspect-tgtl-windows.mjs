import JSZip from 'jszip';
import { readFileSync } from 'node:fs';

const [elementName, drawingName, labelsArg = ''] = process.argv.slice(2);

if (!elementName || !drawingName) {
  console.error('Usage: node scripts/inspect-tgtl-windows.mjs <elementName> <drawingName> [label1,label2,...]');
  process.exit(1);
}

const wanted = new Set(labelsArg.split(',').map(label => label.trim()).filter(Boolean));
const zip = await JSZip.loadAsync(readFileSync('./sample/toon/CH_Anna_rig_football_suit_V001_V07.zip'));
const base = `CH_Anna_rig_football_suit_V001_V07/elements/${elementName}`;
const file = zip.file(`${base}/${drawingName}.tvg`);
if (!file) {
  console.error(`Missing TVG: ${base}/${drawingName}.tvg`);
  process.exit(1);
}

const data = new Uint8Array(await file.async('arraybuffer'));
const utf16LeDecoder = new TextDecoder('utf-16le');
const utf16BeDecoder = new TextDecoder('utf-16be');

function readTag(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function readU32LE(bytes, offset) {
  return bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24);
}

function isPlausibleTGTLString(value) {
  const normalized = value.replace(/\0/g, '').trim();
  if (normalized.length === 0 || normalized.length > 96) return false;
  return /^[\p{L}\p{N}\s,./&+_\-:\r]+$/u.test(normalized);
}

function sanitizeTGTLString(value) {
  const sanitized = value
    .replace(/\0/g, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}\s,./&+_\-:\r]+$/u, '')
    .trim();
  const asciiRuns = sanitized.match(/[A-Za-z0-9][A-Za-z0-9 ,./&+_\-:\r]*/g);
  if (asciiRuns && asciiRuns.length > 0) {
    return asciiRuns.sort((a, b) => b.length - a.length)[0].trim();
  }
  return sanitized;
}

function scoreTGTLStringCandidate(value) {
  if (!isPlausibleTGTLString(value)) return Number.NEGATIVE_INFINITY;
  const basicAsciiChars = value.match(/[A-Za-z0-9 ,./&+_\-:\r]/g)?.length ?? 0;
  const latinChars = value.match(/[\p{Script=Latin}]/gu)?.length ?? 0;
  const cjkChars = value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  if (basicAsciiChars === 0 && cjkChars === 0) return Number.NEGATIVE_INFINITY;
  return value.length + basicAsciiChars * 6 + Math.max(0, latinChars - basicAsciiChars) - cjkChars * 6;
}

function extractLengthPrefixedUTF16Strings(bytes) {
  const strings = [];
  for (let offset = 0; offset <= bytes.length - 4; offset++) {
    const charLen = bytes[offset] | (bytes[offset + 1] << 8);
    if (charLen <= 0 || charLen > 96) continue;
    let best = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestEnd = -1;
    for (const start of [offset + 2, offset + 4, offset + 6, offset + 8]) {
      const end = start + charLen * 2;
      if (end > bytes.length) continue;
      const slice = bytes.slice(start, end);
      for (const decoded of [
        sanitizeTGTLString(utf16LeDecoder.decode(slice)),
        sanitizeTGTLString(utf16BeDecoder.decode(slice)),
      ]) {
        const score = scoreTGTLStringCandidate(decoded);
        if (score <= bestScore) continue;
        best = decoded;
        bestScore = score;
        bestEnd = end;
      }
    }
    if (!best) continue;
    strings.push({ offset, value: best, score: bestScore });
    offset = Math.max(offset, bestEnd - 1);
  }
  return strings;
}

const rows = [];
for (let offset = 0; offset + 8 <= data.length; offset++) {
  if (readTag(data, offset) !== 'TGTL') continue;
  const length = readU32LE(data, offset + 4);
  const start = offset + 8;
  const end = start + length;
  if (length <= 0 || end > data.length) continue;
  const payload = data.slice(start, end);
  const strings = extractLengthPrefixedUTF16Strings(payload);
  const text = strings
    .filter(entry => !/arial/i.test(entry.value))
    .sort((a, b) => b.score - a.score || b.value.length - a.value.length)[0]?.value;
  if (!text) continue;
  if (wanted.size > 0 && !wanted.has(text)) continue;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const markers = [];
  for (let marker = 0; marker <= payload.length - 32; marker += 8) {
    const a = view.getFloat64(marker, true);
    const b = view.getFloat64(marker + 24, true);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (Math.abs(a - 2500) > 0.01 || Math.abs(b - 2500) > 0.01) continue;
    const window = [];
    for (let rel = -12; rel <= 8; rel++) {
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
  rows.push({ offset, length, text, strings, markers });
  offset = end - 1;
}

console.log(JSON.stringify(rows, null, 2));
