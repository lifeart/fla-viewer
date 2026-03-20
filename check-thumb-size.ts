import JSZip from 'jszip';
import { readFileSync } from 'fs';

async function main() {
  const buf = readFileSync('sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
  const zip = await JSZip.loadAsync(buf);

  const thumbPaths = [
    'elements/F-Hand_OL_1_F/.thumbnails/.F-Hand_OL_1_F-14.tvg.png',
    'elements/F-Hand_OL_1_F/.thumbnails/.F-Hand_OL_1_F-11.tvg.png',
    'elements/F_3_symbol/.thumbnails/.F_3_symbol-1.tvg.png',
    'elements/Number_Body/.thumbnails/.Number_Body-1.tvg.png',
  ];

  const tvgFiles: string[] = [];
  zip.forEach(p => { if (p.endsWith('.tvg')) tvgFiles.push(p); });
  const prefix = tvgFiles[0].substring(0, tvgFiles[0].indexOf('elements/'));

  for (const tp of thumbPaths) {
    const file = zip.file(prefix + tp);
    if (!file) { console.log(tp + ': not found'); continue; }
    const data = await file.async('uint8array');

    // Parse PNG header to get dimensions
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    // IHDR chunk: 4 bytes length + "IHDR" + 4 bytes width + 4 bytes height
    if (data[0] === 0x89 && data[1] === 0x50) {
      const width = (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
      const height = (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];
      console.log(`${tp.split('/').pop()}: ${width}×${height} pixels, file size: ${data.length} bytes`);
    }
  }
}
main().catch(console.error);
