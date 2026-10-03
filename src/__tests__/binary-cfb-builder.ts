/**
 * Test helper: a minimal CFB (OLE2) v3 container writer, so tests can wrap
 * synthetic `Contents` / `Page N` / `Symbol N` streams into a binary `.fla`.
 */

const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v: number): number[] => [
  v & 0xff,
  (v >> 8) & 0xff,
  (v >> 16) & 0xff,
  (v >>> 24) & 0xff,
];

// ── minimal CFB v3 writer (port of scripts/make-timeline-fixture.mjs) ───────
// Streams shorter than the 4096-byte mini cutoff are zero-padded (no mini-FAT
// is written); longer streams keep their exact size.
export function buildCFB(streams: { name: string; data: Uint8Array }[]): Uint8Array {
  const SECTOR = 512;
  const ENDOFCHAIN = 0xfffffffe;
  const FREESECT = 0xffffffff;
  const NOSTREAM = 0xffffffff;
  const FATSECT = 0xfffffffd;
  const entries: { name: string; type: number; data: Uint8Array }[] = [
    { name: 'Root Entry', type: 5, data: new Uint8Array(0) },
  ];
  for (const s of streams) {
    let data = s.data;
    if (data.length < 4096) {
      const p = new Uint8Array(4096);
      p.set(data);
      data = p;
    }
    entries.push({ name: s.name, type: 2, data });
  }
  const sectors: Uint8Array[] = [];
  const fat: number[] = [];
  const allocChain = (data: Uint8Array): number => {
    if (data.length === 0) return ENDOFCHAIN;
    const first = sectors.length;
    const n = Math.ceil(data.length / SECTOR);
    for (let i = 0; i < n; i++) {
      const sec = new Uint8Array(SECTOR);
      sec.set(data.subarray(i * SECTOR, (i + 1) * SECTOR));
      sectors.push(sec);
      fat.push(sectors.length);
    }
    fat[first + n - 1] = ENDOFCHAIN;
    return first;
  };
  const starts = entries.map((e) => (e.type === 2 ? allocChain(e.data) : ENDOFCHAIN));
  const dirBytes: number[] = [];
  entries.forEach((e, i) => {
    const ent = new Uint8Array(128);
    for (let j = 0; j < e.name.length; j++) {
      ent[j * 2] = e.name.charCodeAt(j) & 0xff;
      ent[j * 2 + 1] = (e.name.charCodeAt(j) >> 8) & 0xff;
    }
    const nameLen = (e.name.length + 1) * 2;
    ent[64] = nameLen & 0xff;
    ent[65] = nameLen >> 8;
    ent[66] = e.type;
    ent[67] = 1;
    const w32 = (off: number, v: number) => ent.set(u32(v), off);
    w32(68, NOSTREAM);
    w32(72, NOSTREAM);
    w32(76, NOSTREAM);
    if (i === 0) {
      w32(76, entries.length > 1 ? 1 : NOSTREAM);
      w32(116, ENDOFCHAIN);
      w32(120, 0);
    } else {
      if (i + 1 < entries.length) w32(72, i + 1);
      w32(116, starts[i]);
      w32(120, e.data.length);
    }
    dirBytes.push(...ent);
  });
  while (dirBytes.length % SECTOR !== 0) dirBytes.push(0);
  const dirStart = allocChain(Uint8Array.from(dirBytes));
  let fatSectorCount = 1;
  for (;;) {
    const needed = Math.ceil((sectors.length + fatSectorCount) / (SECTOR / 4));
    if (needed === fatSectorCount) break;
    fatSectorCount = needed;
  }
  const fatStart = sectors.length;
  for (let i = 0; i < fatSectorCount; i++) {
    sectors.push(new Uint8Array(SECTOR));
    fat.push(FATSECT);
  }
  while (fat.length % (SECTOR / 4) !== 0) fat.push(FREESECT);
  fat.forEach((v, i) => {
    sectors[fatStart + Math.floor(i / (SECTOR / 4))].set(u32(v), (i % (SECTOR / 4)) * 4);
  });
  const header = new Uint8Array(SECTOR);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  header.set(u16(0x3e), 0x18);
  header.set(u16(3), 0x1a);
  header.set(u16(0xfffe), 0x1c);
  header.set(u16(9), 0x1e);
  header.set(u16(6), 0x20);
  header.set(u32(fatSectorCount), 0x2c);
  header.set(u32(dirStart), 0x30);
  header.set(u32(4096), 0x38);
  header.set(u32(ENDOFCHAIN), 0x3c);
  header.set(u32(0), 0x40);
  header.set(u32(ENDOFCHAIN), 0x44);
  header.set(u32(0), 0x48);
  for (let i = 0; i < 109; i++) {
    header.set(u32(i < fatSectorCount ? fatStart + i : FREESECT), 0x4c + i * 4);
  }
  const total = new Uint8Array(SECTOR + sectors.length * SECTOR);
  total.set(header, 0);
  sectors.forEach((s, i) => total.set(s, SECTOR + i * SECTOR));
  return total;
}
