import JSZip from 'jszip';

/**
 * Uncompressed XFL ("Save as XFL", Flash CS5+): instead of one zipped .fla, the
 * document is a folder holding DOMDocument.xml, LIBRARY/, bin/ … plus a tiny
 * `<name>.xfl` stub whose only content is the text `PROXY-CS5`. The folder holds
 * exactly what a .fla archive holds, so it is loaded by packing it into an
 * in-memory archive and running the normal XFL parser on that.
 */
export interface XFLFolderEntry {
  /** Path inside the dropped folder, `/` or `\` separated (e.g. `MyAnim/LIBRARY/Hero.xml`). */
  path: string;
  data: Blob | Uint8Array | ArrayBuffer;
}

/** Text of the `.xfl` stub file Flash writes next to DOMDocument.xml. */
export const XFL_STUB_CONTENT = 'PROXY-CS5';

/**
 * Pack an XFL folder into a JSZip with DOMDocument.xml at the root. The folder
 * may be wrapped in any number of parent directories; the shallowest
 * DOMDocument.xml decides the document root and files outside it are ignored.
 */
export function xflFolderToZip(entries: XFLFolderEntry[]): JSZip {
  const normalized = entries.map((e) => ({ ...e, path: e.path.replace(/\\/g, '/').replace(/^\/+/, '') }));

  let root: string | null = null;
  for (const { path } of normalized) {
    const m = /^(.*\/)?DOMDocument\.xml$/i.exec(path);
    if (!m) continue;
    const prefix = m[1] ?? '';
    if (root === null || prefix.split('/').length < root.split('/').length) root = prefix;
  }
  if (root === null) {
    throw new Error('Invalid XFL folder: DOMDocument.xml not found');
  }

  const zip = new JSZip();
  for (const { path, data } of normalized) {
    if (!path.startsWith(root)) continue;
    const relative = path.slice(root.length);
    if (relative === '') continue;
    // Keep the conventional file name (the parser looks up DOMDocument.xml exactly).
    zip.file(/^DOMDocument\.xml$/i.test(relative) ? 'DOMDocument.xml' : relative, data);
  }
  return zip;
}

/** True when bytes are the `.xfl` stub (which alone cannot be opened). */
export function isXFLStub(bytes: Uint8Array): boolean {
  if (bytes.length > 64) return false;
  return new TextDecoder().decode(bytes).trim() === XFL_STUB_CONTENT;
}

/**
 * Read every file under a dropped directory (File and Directory Entries API,
 * `DataTransferItem.webkitGetAsEntry()`), with paths relative to the drop.
 */
export async function readDirectoryEntry(dir: FileSystemDirectoryEntry): Promise<XFLFolderEntry[]> {
  const out: XFLFolderEntry[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ path: prefix + entry.name, data: file });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns results in batches; keep reading until it returns none.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, prefix + entry.name + '/');
    }
  };
  await walk(dir, '');
  return out;
}
