import JSZip from 'jszip';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pako from 'pako';

const ZIP_PATH = './sample/toon/CH_Anna_rig_football_suit_V001_V07.zip';
const OUT_DIR = '/Users/lifeart/Repos/fla-viewer/test-results';

function hexDump(data: Uint8Array, offset: number, length: number, label: string): void {
  console.log(`\n=== ${label} (${length} bytes at offset 0x${offset.toString(16)}) ===`);
  for (let i = 0; i < length; i += 16) {
    const hex: string[] = [];
    const ascii: string[] = [];
    for (let j = 0; j < 16 && i + j < length; j++) {
      const b = data[offset + i + j];
      hex.push(b.toString(16).padStart(2, '0'));
      ascii.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.');
    }
    console.log(`  ${(offset + i).toString(16).padStart(6, '0')}: ${hex.join(' ').padEnd(48)} ${ascii.join('')}`);
  }
}

function findTag(data: Uint8Array, tag: string, start: number, end: number): number {
  const t0 = tag.charCodeAt(0), t1 = tag.charCodeAt(1), t2 = tag.charCodeAt(2), t3 = tag.charCodeAt(3);
  for (let i = start; i < end - 3; i++) {
    if (data[i] === t0 && data[i + 1] === t1 && data[i + 2] === t2 && data[i + 3] === t3) return i;
  }
  return -1;
}

function findAllTag(data: Uint8Array, tag: string, start: number, end: number): number[] {
  const positions: number[] = [];
  const t0 = tag.charCodeAt(0), t1 = tag.charCodeAt(1), t2 = tag.charCodeAt(2), t3 = tag.charCodeAt(3);
  for (let i = start; i < end - 3; i++) {
    if (data[i] === t0 && data[i + 1] === t1 && data[i + 2] === t2 && data[i + 3] === t3) positions.push(i);
  }
  return positions;
}

function readInnerTagAt(data: Uint8Array, pos: number): { tag: string; contentStart: number; contentLen: number } | null {
  if (pos + 5 > data.length) return null;
  const tag = String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3]);
  const type = data[pos + 4];
  let len = 0, hdrSize = 5;
  const lenBytes = (type >> 1) & 0x03;
  if (lenBytes === 0) { len = data[pos + 5]; hdrSize = 6; }
  else if (lenBytes === 1) { len = data[pos + 5] | (data[pos + 6] << 8); hdrSize = 7; }
  else if (lenBytes === 2 || lenBytes === 3) { len = data[pos + 5] | (data[pos + 6] << 8) | (data[pos + 7] << 16); hdrSize = 8; }
  else return null;
  return { tag, contentStart: pos + hdrSize, contentLen: len };
}

function findPNG(data: Uint8Array, start: number, end: number): { start: number; end: number } | null {
  for (let i = start; i < end - 8; i++) {
    if (data[i] === 0x89 && data[i + 1] === 0x50 && data[i + 2] === 0x4E && data[i + 3] === 0x47 &&
      data[i + 4] === 0x0D && data[i + 5] === 0x0A && data[i + 6] === 0x1A && data[i + 7] === 0x0A) {
      for (let e = i + 8; e < end - 3; e++) {
        if (data[e] === 0x49 && data[e + 1] === 0x45 && data[e + 2] === 0x4E && data[e + 3] === 0x44) {
          return { start: i, end: e + 8 }; // IEND chunk: len(4)+tag(4)+CRC(4)=12, but end marker at tag start +8 to include CRC
        }
      }
    }
  }
  return null;
}

/** Decode UNCO/ZLIB blocks from raw TVG buffer */
function decodeBlocks(raw: Uint8Array): { encoding: string; decoded: Uint8Array; rawOffset: number }[] {
  const results: { encoding: string; decoded: Uint8Array; rawOffset: number }[] = [];
  for (let i = 0; i < raw.length - 8; i++) {
    const tag = String.fromCharCode(raw[i], raw[i + 1], raw[i + 2], raw[i + 3]);
    if (tag === 'UNCO') {
      const len = raw[i + 4] | (raw[i + 5] << 8) | (raw[i + 6] << 16) | (raw[i + 7] << 24);
      if (len > 0 && len <= raw.length - i - 8) {
        results.push({ encoding: 'UNCO', decoded: raw.slice(i + 8, i + 8 + len), rawOffset: i });
        i += 8 + len - 1;
      }
    } else if (tag === 'ZLIB') {
      const totalLen = raw[i + 4] | (raw[i + 5] << 8) | (raw[i + 6] << 16) | (raw[i + 7] << 24);
      if (totalLen > 4 && totalLen <= raw.length - i - 8) {
        const compressedLen = totalLen - 4;
        try {
          const decoded = pako.inflate(raw.slice(i + 12, i + 12 + compressedLen));
          results.push({ encoding: 'ZLIB', decoded, rawOffset: i });
        } catch {
          try {
            const decoded = pako.inflateRaw(raw.slice(i + 12, i + 12 + compressedLen));
            results.push({ encoding: 'ZLIB-raw', decoded, rawOffset: i });
          } catch { /* skip */ }
        }
        i += 8 + totalLen - 1;
      }
    }
  }
  return results;
}

function analyzePNG(data: Uint8Array, label: string): void {
  // Parse PNG header chunks to check color type
  if (data.length < 33) return;
  // Skip signature (8 bytes)
  let pos = 8;
  while (pos < data.length - 8) {
    const chunkLen = (data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3];
    const chunkType = String.fromCharCode(data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]);
    if (chunkType === 'IHDR' && chunkLen >= 13) {
      const width = (data[pos + 8] << 24) | (data[pos + 9] << 16) | (data[pos + 10] << 8) | data[pos + 11];
      const height = (data[pos + 12] << 24) | (data[pos + 13] << 16) | (data[pos + 14] << 8) | data[pos + 15];
      const bitDepth = data[pos + 16];
      const colorType = data[pos + 17];
      const compression = data[pos + 18];
      const filter = data[pos + 19];
      const interlace = data[pos + 20];
      const colorTypeStr = ['Grayscale', '', 'RGB', 'Indexed', 'Grayscale+Alpha', '', 'RGBA'][colorType] || `Unknown(${colorType})`;
      console.log(`  ${label} PNG IHDR: ${width}x${height}, bitDepth=${bitDepth}, colorType=${colorType} (${colorTypeStr}), compression=${compression}, filter=${filter}, interlace=${interlace}`);
    } else if (chunkType === 'PLTE') {
      console.log(`  ${label} PNG PLTE: ${chunkLen / 3} palette entries`);
      // Show first few entries
      for (let j = 0; j < Math.min(chunkLen, 30); j += 3) {
        const r = data[pos + 8 + j], g = data[pos + 8 + j + 1], b = data[pos + 8 + j + 2];
        console.log(`    entry ${j / 3}: rgb(${r}, ${g}, ${b})`);
      }
    } else if (chunkType === 'tRNS') {
      console.log(`  ${label} PNG tRNS: ${chunkLen} bytes`);
    } else if (chunkType === 'sBIT') {
      console.log(`  ${label} PNG sBIT: ${Array.from(data.slice(pos + 8, pos + 8 + chunkLen)).join(', ')}`);
    } else if (chunkType === 'IEND') {
      break;
    }
    // Show non-IDAT chunks
    if (chunkType !== 'IDAT') {
      // already handled above
    }
    pos += 12 + chunkLen; // 4 len + 4 type + data + 4 crc
  }
}

function scanForSubTags(data: Uint8Array, start: number, end: number, indent: string = '  '): void {
  // Look for 4-letter tags that start with 'T' (Toon Boom convention)
  let pos = start;
  const seen = new Set<string>();
  while (pos < end - 4) {
    // Check if this looks like a tag (4 printable ASCII chars)
    const c0 = data[pos], c1 = data[pos + 1], c2 = data[pos + 2], c3 = data[pos + 3];
    if (c0 >= 0x41 && c0 <= 0x5a && c1 >= 0x41 && c1 <= 0x7a && c2 >= 0x41 && c2 <= 0x7a && c3 >= 0x41 && c3 <= 0x7a) {
      const tag = String.fromCharCode(c0, c1, c2, c3);
      if (tag.startsWith('TB') || tag.startsWith('TG') || tag.startsWith('tG') || tag.startsWith('TC')) {
        const inner = readInnerTagAt(data, pos);
        if (inner && inner.contentLen > 0 && inner.contentLen < 100000 && inner.contentStart + inner.contentLen <= end) {
          if (!seen.has(`${tag}@${pos}`)) {
            seen.add(`${tag}@${pos}`);
            console.log(`${indent}Found sub-tag: ${tag} at offset 0x${pos.toString(16)}, content length=${inner.contentLen}`);
            if (inner.contentLen <= 64) {
              hexDump(data, inner.contentStart, inner.contentLen, `${indent}  ${tag} content`);
            } else {
              hexDump(data, inner.contentStart, Math.min(64, inner.contentLen), `${indent}  ${tag} content (first 64 bytes)`);
            }
            // Special handling for TBBA
            if (tag === 'TBBA' && inner.contentLen >= 16) {
              const dv = new DataView(data.buffer, data.byteOffset + inner.contentStart, inner.contentLen);
              console.log(`${indent}  TBBA clip rect: x=${dv.getInt32(0, true)}, y=${dv.getInt32(4, true)}, w=${dv.getInt32(8, true)}, h=${dv.getInt32(12, true)}`);
              if (inner.contentLen > 16) {
                console.log(`${indent}  TBBA extra bytes (${inner.contentLen - 16}):`);
                hexDump(data, inner.contentStart + 16, inner.contentLen - 16, `${indent}    TBBA extra`);
              }
            }
            // TBBD - tile grid size
            if (tag === 'TBBD' && inner.contentLen >= 8) {
              const dv = new DataView(data.buffer, data.byteOffset + inner.contentStart, inner.contentLen);
              console.log(`${indent}  TBBD values: ${dv.getInt32(0, true)}, ${dv.getInt32(4, true)}`);
            }
            // TBBC - canvas bounds
            if (tag === 'TBBC' && inner.contentLen >= 16) {
              const dv = new DataView(data.buffer, data.byteOffset + inner.contentStart, inner.contentLen);
              console.log(`${indent}  TBBC bounds: x=${dv.getInt32(0, true)}, y=${dv.getInt32(4, true)}, w=${dv.getInt32(8, true)}, h=${dv.getInt32(12, true)}`);
            }
          }
        }
      }
    }
    pos++;
  }
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  console.log(`Loading zip: ${ZIP_PATH}`);
  const zipData = fs.readFileSync(ZIP_PATH);
  const zip = await JSZip.loadAsync(zipData);

  // Find all files
  const allFiles: string[] = [];
  zip.forEach((p) => { allFiles.push(p); });

  // Find TVG file for element 6172, drawing 1
  const tvgPattern = /6172.*-1\.tvg$/i;
  const tvgFiles = allFiles.filter(p => tvgPattern.test(p));
  console.log(`\nTVG files matching *6172*-1.tvg:`);
  for (const f of tvgFiles) console.log(`  ${f}`);

  // Also check broader pattern
  const allTvgWith6172 = allFiles.filter(p => p.includes('6172') && p.endsWith('.tvg'));
  if (allTvgWith6172.length > tvgFiles.length) {
    console.log(`\nAll TVG files with "6172":`);
    for (const f of allTvgWith6172) console.log(`  ${f}`);
  }

  if (tvgFiles.length === 0) {
    console.error('No matching TVG file found!');
    // List all element folders to help
    const elemFolders = new Set<string>();
    allFiles.forEach(p => {
      const m = p.match(/elements\/(\d+)\//);
      if (m) elemFolders.add(m[1]);
    });
    console.log('\nAvailable element IDs:', [...elemFolders].sort().join(', '));
    return;
  }

  const tvgPath = tvgFiles[0];
  console.log(`\nUsing TVG: ${tvgPath}`);

  // Find thumbnail for this element
  const thumbPattern = allFiles.filter(p => p.includes('6172') && p.endsWith('.png'));
  console.log(`\nThumbnail PNGs for element 6172:`);
  for (const f of thumbPattern) console.log(`  ${f}`);
  if (thumbPattern.length > 0) {
    const thumbFile = zip.file(thumbPattern[0]);
    if (thumbFile) {
      const thumbData = await thumbFile.async('uint8array');
      const refPath = path.join(OUT_DIR, 'bitmap_ref.png');
      fs.writeFileSync(refPath, thumbData);
      console.log(`  Saved reference thumbnail to: ${refPath} (${thumbData.length} bytes)`);
    }
  }

  // Read the TVG file
  const tvgFile = zip.file(tvgPath);
  if (!tvgFile) { console.error('Cannot read TVG file'); return; }
  const raw = new Uint8Array(await tvgFile.async('arraybuffer'));
  console.log(`\nTVG file size: ${raw.length} bytes`);

  // Show header
  hexDump(raw, 0, Math.min(32, raw.length), 'TVG Header');

  // ========== PART 1: Raw scan for TGBG/TBBM in raw data ==========
  console.log('\n\n========== RAW DATA SCAN ==========');

  const rawTGBG = findAllTag(raw, 'TGBG', 0, raw.length);
  console.log(`TGBG occurrences in raw data: ${rawTGBG.length}`);
  for (const pos of rawTGBG) {
    hexDump(raw, pos, Math.min(32, raw.length - pos), `Raw TGBG at 0x${pos.toString(16)}`);
  }

  const rawTBBM = findAllTag(raw, 'TBBM', 0, raw.length);
  console.log(`TBBM occurrences in raw data: ${rawTBBM.length}`);

  // ========== PART 2: Decode UNCO/ZLIB blocks ==========
  console.log('\n\n========== DECODED BLOCKS SCAN ==========');

  const blocks = decodeBlocks(raw);
  console.log(`Found ${blocks.length} UNCO/ZLIB blocks`);

  let tileCount = 0;
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const decoded = block.decoded;
    console.log(`\nBlock ${bi}: ${block.encoding} at raw offset 0x${block.rawOffset.toString(16)}, decoded size=${decoded.length}`);

    // Check for TGBG in decoded
    const tgbgPositions = findAllTag(decoded, 'TGBG', 0, decoded.length);
    if (tgbgPositions.length > 0) {
      console.log(`  Found ${tgbgPositions.length} TGBG tags in decoded block`);
      for (const tgbgPos of tgbgPositions) {
        const tgbg = readInnerTagAt(decoded, tgbgPos);
        if (tgbg) {
          console.log(`  TGBG at 0x${tgbgPos.toString(16)}: contentLen=${tgbg.contentLen}, contentStart=0x${tgbg.contentStart.toString(16)}`);
          hexDump(decoded, tgbgPos, Math.min(48, decoded.length - tgbgPos), `TGBG header`);
        }
      }
    }

    // Check for TBBM in decoded
    const tbbmPositions = findAllTag(decoded, 'TBBM', 0, decoded.length);
    if (tbbmPositions.length > 0) {
      console.log(`  Found ${tbbmPositions.length} TBBM tiles in decoded block`);
    }

    for (const tbbmPos of tbbmPositions) {
      const tbbm = readInnerTagAt(decoded, tbbmPos);
      if (!tbbm) { console.log(`  TBBM at 0x${tbbmPos.toString(16)}: failed to parse inner tag`); continue; }

      const tEnd = tbbm.contentStart + tbbm.contentLen;
      console.log(`\n  ---- TBBM tile ${tileCount} at 0x${tbbmPos.toString(16)} ----`);
      console.log(`  Tag type byte: 0x${decoded[tbbmPos + 4].toString(16)}`);
      console.log(`  Content start: 0x${tbbm.contentStart.toString(16)}, content length: ${tbbm.contentLen}`);

      // Hex dump the entire TBBM header area (first 128 bytes of content or until PNG)
      const png = findPNG(decoded, tbbm.contentStart, tEnd);
      const headerEnd = png ? png.start : Math.min(tEnd, tbbm.contentStart + 256);
      const headerLen = headerEnd - tbbm.contentStart;
      hexDump(decoded, tbbmPos, Math.min(headerLen + (tbbm.contentStart - tbbmPos), 256), `TBBM #${tileCount} full header`);

      // Scan for all sub-tags within TBBM
      console.log(`\n  Sub-tags within TBBM #${tileCount}:`);
      scanForSubTags(decoded, tbbm.contentStart, tEnd, '    ');

      // Also specifically look for TBBH
      const tbbhPos = findTag(decoded, 'TBBH', tbbm.contentStart, tEnd);
      if (tbbhPos >= 0) {
        const tbbh = readInnerTagAt(decoded, tbbhPos);
        if (tbbh) {
          console.log(`\n    TBBH at 0x${tbbhPos.toString(16)}: contentLen=${tbbh.contentLen}`);
          hexDump(decoded, tbbhPos, Math.min(tbbh.contentLen + 8, 128), `TBBH #${tileCount}`);
          // Scan sub-tags within TBBH
          scanForSubTags(decoded, tbbh.contentStart, tbbh.contentStart + tbbh.contentLen, '      ');
        }
      }

      if (png) {
        const pngData = decoded.slice(png.start, png.end);
        const outPath = path.join(OUT_DIR, `bitmap_tile_${tileCount}.png`);
        fs.writeFileSync(outPath, pngData);
        console.log(`\n    PNG found: offset 0x${png.start.toString(16)} - 0x${png.end.toString(16)} (${pngData.length} bytes)`);
        console.log(`    Saved to: ${outPath}`);

        // Analyze PNG structure
        analyzePNG(pngData, `    Tile ${tileCount}`);

        // Show bytes between header and PNG start (may contain color metadata)
        const gapStart = tbbm.contentStart;
        const gapEnd = png.start;
        if (gapEnd - gapStart > 0) {
          console.log(`\n    Bytes between TBBM content start and PNG (${gapEnd - gapStart} bytes):`);
          hexDump(decoded, gapStart, Math.min(gapEnd - gapStart, 256), `Pre-PNG gap tile ${tileCount}`);
        }
      } else {
        console.log(`    No PNG found in TBBM #${tileCount}`);
      }

      // Extract TBBA clip rect
      let clipX = 0, clipY = 0, clipW = 0, clipH = 0;
      const tbbaPos = findTag(decoded, 'TBBA', tbbm.contentStart, Math.min(tEnd, tbbm.contentStart + 200));
      if (tbbaPos >= 0) {
        const tbba = readInnerTagAt(decoded, tbbaPos);
        if (tbba && tbba.contentLen >= 16) {
          const dv = new DataView(decoded.buffer, decoded.byteOffset + tbba.contentStart, tbba.contentLen);
          clipX = dv.getInt32(0, true);
          clipY = dv.getInt32(4, true);
          clipW = dv.getInt32(8, true);
          clipH = dv.getInt32(12, true);
          console.log(`    TBBA clip: x=${clipX}, y=${clipY}, w=${clipW}, h=${clipH}`);
        }
      }

      tileCount++;
    }

    // Also look for nested UNCO/ZLIB within decoded block
    const nestedBlocks = decodeBlocks(decoded);
    for (const nested of nestedBlocks) {
      console.log(`\n  Nested ${nested.encoding} block (decoded size=${nested.decoded.length})`);
      const nestedTBBM = findAllTag(nested.decoded, 'TBBM', 0, nested.decoded.length);
      if (nestedTBBM.length > 0) {
        console.log(`    Found ${nestedTBBM.length} TBBM in nested block`);
        for (const tbbmPos of nestedTBBM) {
          const tbbm = readInnerTagAt(nested.decoded, tbbmPos);
          if (!tbbm) continue;
          const tEnd = tbbm.contentStart + tbbm.contentLen;
          console.log(`\n    ---- Nested TBBM tile ${tileCount} ----`);
          hexDump(nested.decoded, tbbmPos, Math.min(128, nested.decoded.length - tbbmPos), `Nested TBBM #${tileCount}`);
          scanForSubTags(nested.decoded, tbbm.contentStart, tEnd, '      ');

          const png = findPNG(nested.decoded, tbbm.contentStart, tEnd);
          if (png) {
            const pngData = nested.decoded.slice(png.start, png.end);
            const outPath = path.join(OUT_DIR, `bitmap_tile_${tileCount}.png`);
            fs.writeFileSync(outPath, pngData);
            console.log(`      Saved nested tile PNG: ${outPath} (${pngData.length} bytes)`);
            analyzePNG(pngData, `      Nested tile ${tileCount}`);
          }
          tileCount++;
        }
      }
    }
  }

  // ========== PART 3: Use parseTVG to get the parsed result ==========
  console.log('\n\n========== parseTVG() RESULT ==========');
  try {
    // Dynamic import since parseTVG uses pako which needs to resolve
    const { parseTVG } = await import('./src/tvg-parser.ts');
    const drawing = parseTVG(raw.buffer);
    console.log(`Layers: ${drawing.layers.length}`);
    console.log(`Palette entries: ${drawing.palette.length}`);
    console.log(`Bitmap tiles: ${drawing.bitmapTiles.length}`);
    console.log(`Point quantum: ${drawing.pointQuantum}`);

    for (let i = 0; i < drawing.bitmapTiles.length; i++) {
      const tile = drawing.bitmapTiles[i];
      console.log(`\n  Tile ${i}: clip=(${tile.clipX}, ${tile.clipY}, ${tile.clipW}, ${tile.clipH}), pngData=${tile.pngData.length} bytes`);
      analyzePNG(tile.pngData, `  Parsed tile ${i}`);

      // Save parsed tiles too (for comparison)
      const parsedPath = path.join(OUT_DIR, `bitmap_parsed_tile_${i}.png`);
      fs.writeFileSync(parsedPath, tile.pngData);
      console.log(`  Saved parsed tile: ${parsedPath}`);

      // Check first few pixels of raw PNG data to see if channel order is off
      // Look at the IHDR to determine format
      if (tile.pngData.length > 33) {
        const colorType = tile.pngData[25]; // byte 17 of IHDR data, which starts at offset 8(sig)+4(len)+4(IHDR)=16, so byte 25
        console.log(`  Color type from raw bytes: ${colorType}`);
      }
    }

    if (drawing.palette.length > 0) {
      console.log('\n  Palette:');
      for (let i = 0; i < Math.min(drawing.palette.length, 20); i++) {
        const p = drawing.palette[i];
        console.log(`    [${i}] id=${(p as any).id ?? '?'} rgba=(${(p as any).r},${(p as any).g},${(p as any).b},${(p as any).a})`);
      }
    }
  } catch (e) {
    console.error('parseTVG failed:', e);
  }

  console.log(`\n\nTotal tiles found: ${tileCount}`);
  console.log('Done.');
}

main().catch(console.error);
