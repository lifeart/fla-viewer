/**
 * Dev-only OLE2 stream inspector for issue #42 binary-path RE. Lists streams and
 * locates needle strings (ASCII + UTF-16LE) with surrounding byte context, so we
 * can see how linkage class names / instance names are encoded in `Contents` and
 * `Symbol N` / `Page N` streams. NOT shipped.
 *
 *   node scripts/run-inspect.mjs file.fla "Needle1,Needle2"
 */
import { readFileSync } from 'node:fs';
import { OLE2File } from '../src/ole2-reader';

function ascii(bytes: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = start; i < start + len && i < bytes.length; i++) {
    const c = bytes[i];
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '·';
  }
  return s;
}

function indexAll(hay: Uint8Array, needle: Uint8Array): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function utf16le(s: string): Uint8Array {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) b[i * 2] = s.charCodeAt(i) & 0xff;
  return b;
}
function asciiBytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

const path = process.argv[2];
const bytes = new Uint8Array(readFileSync(path));
const ole = new OLE2File(bytes);

// Hex-dump mode: node run-inspect.mjs file.fla --hex <stream> <start> <len>
if (process.argv[3] === '--hex') {
  const streamName = process.argv[4];
  const start = parseInt(process.argv[5] || '0', 10);
  const len = parseInt(process.argv[6] || '128', 10);
  const data = ole.readStream(streamName);
  for (let row = start; row < start + len && row < data.length; row += 16) {
    const n = Math.min(16, data.length - row);
    let hex = '', txt = '';
    for (let i = 0; i < n; i++) {
      hex += data[row + i].toString(16).padStart(2, '0') + ' ';
      txt += ascii(data, row + i, 1);
    }
    console.log(`${row.toString().padStart(6)}  ${hex.padEnd(48)} ${txt}`);
  }
  process.exit(0);
}

function readFlashStr(d: Uint8Array, p: number): { str: string; end: number } | null {
  if (d[p] !== 0xff || d[p + 1] !== 0xfe || d[p + 2] !== 0xff) return null;
  const len = d[p + 3];
  const start = p + 4;
  if (start + len * 2 > d.length) return null;
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(d[start + i * 2] | (d[start + i * 2 + 1] << 8));
  return { str: s, end: start + len * 2 };
}

// All Flash strings in a stream: node run-inspect.mjs file.fla --strings "Symbol 34" [start] [len]
if (process.argv[3] === '--strings') {
  const d = ole.readStream(process.argv[4]);
  const start = process.argv[5] ? parseInt(process.argv[5], 10) : 0;
  const end = process.argv[6] ? start + parseInt(process.argv[6], 10) : d.length;
  const dotSig = [0xff, 0xfe, 0xff, 0x01, 0x2e, 0x00];
  const markerSig = [0x05, 0x02, 0x00, 0x00, 0x00];
  for (let p = start; p + 4 <= end; p++) {
    if (markerSig.every((b, i) => d[p + i] === b)) { console.log(`@${String(p).padStart(5)}  <05 02 00 00 00 marker>`); p += 4; continue; }
    if (d[p] === 0xff && d[p + 1] === 0xfe && d[p + 2] === 0xff) {
      if (dotSig.every((b, i) => d[p + i] === b)) { console.log(`@${String(p).padStart(5)}  <"." linkage-sep>`); p += 5; continue; }
      const len = d[p + 3];
      if (p + 4 + len * 2 <= d.length) {
        let s = '', ok = true;
        for (let i = 0; i < len; i++) {
          const code = d[p + 4 + i * 2] | (d[p + 4 + i * 2 + 1] << 8);
          if (code < 0x20 || code > 0x7e) { ok = false; break; }
          s += String.fromCharCode(code);
        }
        if (ok) { console.log(`@${String(p).padStart(5)}  [len ${String(len).padStart(2)}] "${s}"`); p += 3 + len * 2; }
      }
    }
  }
  process.exit(0);
}

// CArchive class declarations: node run-inspect.mjs file.fla --carchive
if (process.argv[3] === '--carchive') {
  const d = ole.readStream(process.argv[4] || 'Contents');
  // wNewClassTag = 0xFFFF, then schema(u16), nameLen(u16), name(ASCII)
  let n = 0;
  for (let p = 0; p + 6 < d.length; p++) {
    if (d[p] === 0xff && d[p + 1] === 0xff) {
      const schema = d[p + 2] | (d[p + 3] << 8);
      const nameLen = d[p + 4] | (d[p + 5] << 8);
      if (schema > 0 && schema < 0x4000 && nameLen >= 3 && nameLen <= 40 && p + 6 + nameLen <= d.length) {
        let s = '', ok = true;
        for (let i = 0; i < nameLen; i++) {
          const c = d[p + 6 + i];
          if (c < 0x41 || c > 0x7a) { ok = false; break; }
          s += String.fromCharCode(c);
        }
        if (ok && s[0] === 'C') { console.log(`@${String(p).padStart(6)}  #${++n}  schema=${schema}  class=${s}`); p += 5 + nameLen; }
      }
    }
  }
  process.exit(0);
}

// Interleaved records: node run-inspect.mjs file.fla --records
if (process.argv[3] === '--records') {
  const d = ole.readStream('Contents');
  type Row = { at: number; kind: 'lib' | 'link'; text: string };
  const rows: Row[] = [];
  // library "Symbol N" MFC CString edit-names (prefix + preceding length byte)
  const symPrefix = utf16le('Symbol ');
  for (const at of indexAll(d, symPrefix)) {
    const strLen = at > 0 ? d[at - 1] : 0;
    if (strLen > 0 && strLen < 12 && at + strLen * 2 <= d.length) {
      let s = '';
      for (let i = 0; i < strLen; i++) s += String.fromCharCode(d[at + i * 2] | (d[at + i * 2 + 1] << 8));
      const m = /^Symbol (\d+)$/.exec(s);
      if (m) rows.push({ at, kind: 'lib', text: `editName Symbol ${m[1]}` });
    }
  }
  // linkage "." blocks
  const dot = new Uint8Array([0xff, 0xfe, 0xff, 0x01, 0x2e, 0x00]);
  for (const at of indexAll(d, dot)) {
    const cls = readFlashStr(d, at + 6);
    let id: string | null = null;
    for (let q = at - 4; q >= Math.max(0, at - 64); q--) { const fs = readFlashStr(d, q); if (fs && fs.end === at) { id = fs.str; break; } }
    if (cls && (id || cls.str) && id !== 'null') rows.push({ at, kind: 'link', text: `LINKAGE id="${id}" class="${cls.str}"` });
  }
  rows.sort((a, b) => a.at - b.at);
  for (const r of rows) console.log(`@${String(r.at).padStart(6)}  ${r.kind === 'link' ? '>>' : '  '} ${r.text}`);
  process.exit(0);
}

// Linkage analysis: node run-inspect.mjs file.fla --linkage
if (process.argv[3] === '--linkage') {
  const d = ole.readStream('Contents');
  const sig = asciiBytes('').length; // noop to keep tooling quiet
  void sig;
  // all "Symbol N" keys: UTF-16 "Symbol " preceded by a CString length byte
  const symbolPrefix = utf16le('Symbol ');
  const keys: { num: number; at: number }[] = [];
  for (const at of indexAll(d, symbolPrefix)) {
    const strLen = at > 0 ? d[at - 1] : 0;
    if (strLen > 0 && at + strLen * 2 <= d.length) {
      let s = '';
      for (let i = 0; i < strLen; i++) s += String.fromCharCode(d[at + i * 2] | (d[at + i * 2 + 1] << 8));
      const m = /^Symbol (\d+)$/.exec(s);
      if (m) keys.push({ num: parseInt(m[1], 10), at });
    }
  }
  void keys;
  // Walk each linkage record forward from the "." separator (FF FE FF 01 2E 00):
  //   <identifier> . <className> 05 02 00 00 00 <path> <"Symbol N" edit-name?>
  const dot = new Uint8Array([0xff, 0xfe, 0xff, 0x01, 0x2e, 0x00]);
  const marker = new Uint8Array([0x05, 0x02, 0x00, 0x00, 0x00]);
  for (const at of indexAll(d, dot)) {
    const className = readFlashStr(d, at + 6);
    let identifier: string | null = null;
    for (let q = at - 4; q >= Math.max(0, at - 64); q--) {
      const fs = readFlashStr(d, q);
      if (fs && fs.end === at) { identifier = fs.str; break; }
    }
    if (!className) continue;
    let p = className.end;
    // marker
    let hasMarker = true;
    for (let i = 0; i < 5; i++) if (d[p + i] !== marker[i]) hasMarker = false;
    let symNum: string | number = '?';
    if (hasMarker) {
      p += 5;
      const pathStr = readFlashStr(d, p); // source path (empty for local symbols)
      if (pathStr) p = pathStr.end;
      const nameRef = readFlashStr(d, p); // expect "Symbol N" for local symbols
      const m = nameRef && /^Symbol (\d+)$/.exec(nameRef.str);
      if (m) symNum = parseInt(m[1], 10);
    }
    console.log(`  Symbol ${String(symNum).padStart(3)}  id="${identifier}"  class="${className.str}"`);
  }
  process.exit(0);
}

const needles = (process.argv[3] || '').split(',').map((s) => s.trim()).filter(Boolean);

console.log('=== streams ===');
for (const e of ole.listStreams()) console.log(`  ${e.name}  (${e.size} bytes)`);

for (const streamName of ole.listStreams().map((e) => e.name)) {
  let data: Uint8Array;
  try { data = ole.readStream(streamName); } catch { continue; }
  for (const needle of needles) {
    for (const [label, nb] of [['ascii', asciiBytes(needle)], ['utf16le', utf16le(needle)]] as const) {
      const hits = indexAll(data, nb);
      for (const at of hits.slice(0, 4)) {
        const ctxStart = Math.max(0, at - 12);
        console.log(
          `\n[${streamName}] "${needle}" (${label}) @${at}\n` +
          `   before: ${ascii(data, ctxStart, at - ctxStart)}\n` +
          `   match→after: ${ascii(data, at, nb.length + 40)}`
        );
      }
    }
  }
}
