/**
 * CPicObj base reader (schema, flags, children, registration point, extras)
 * shared by the CPic readers of the second timeline walker. Ported from PR #45
 * (zndxcvbn).
 */
import {
  CArchiveReader,
  type CArchiveObjectHeader,
} from './binary-carchive';

export interface CPicPoint {
  x: number;
  y: number;
}

export interface CPicChild<T> {
  header: CArchiveObjectHeader;
  bodyEnd: number;
  value: T;
}

export interface CPicObjBase<TChild = unknown> {
  bodyStart: number;
  bodyEnd: number;
  schema: number;
  flags: number;
  children: CPicChild<TChild>[];
  registrationPoint?: CPicPoint;
  extra1?: number;
  extra2?: number;
  extra3?: number;
}

export type CPicChildReader<TChild> = (
  header: CArchiveObjectHeader,
  reader: CArchiveReader,
  parentSchema: number
) => TChild;

export interface CPicObjBaseOptions {
  readPreChildren?: (schema: number, flags: number, reader: CArchiveReader) => void;
  stopBeforeChildClasses?: readonly string[];
}

/**
 * Read CPicObj::Serialize's common base:
 *
 *   u8 schema
 *   u8 flags
 *   children-loop { CArchive ReadObject tag; body; ...; NULL }
 *   if schema >= 1: s32 x, s32 y
 *   if schema >= 3: u8 extra1
 *   if schema >= 4: u8 extra2
 *   if schema >= 6: u8 extra3
 *
 * Child body sizes are supplied by the typed child parser. This keeps the
 * native path strict: no sentinel scans and no inferred child boundaries.
 */
export function readCPicObjBase<TChild = unknown>(
  reader: CArchiveReader,
  readChild: CPicChildReader<TChild>,
  options: CPicObjBaseOptions = {}
): CPicObjBase<TChild> {
  const bodyStart = reader.pos;
  const schema = reader.readU8();
  const flags = reader.readU8();
  options.readPreChildren?.(schema, flags, reader);
  const children: CPicChild<TChild>[] = [];

  const base: CPicObjBase<TChild> = {
    bodyStart,
    bodyEnd: reader.pos,
    schema,
    flags,
    children,
  };

  while (true) {
    if (options.stopBeforeChildClasses?.length) {
      const next = reader.peekObjectHeader();
      if (next && options.stopBeforeChildClasses.includes(next.className)) {
        base.bodyEnd = reader.pos;
        return base;
      }
    }
    const header = reader.readObjectHeader();
    if (!header) break;
    const value = readChild(header, reader, schema);
    children.push({ header, bodyEnd: reader.pos, value });
  }

  if (schema >= 1) {
    base.registrationPoint = {
      x: reader.readS32(),
      y: reader.readS32(),
    };
  }
  if (schema >= 3) base.extra1 = reader.readU8();
  if (schema >= 4) base.extra2 = reader.readU8();
  if (schema >= 6) base.extra3 = reader.readU8();

  base.bodyEnd = reader.pos;
  return base;
}

export function readCPicObjLeafBase(reader: CArchiveReader): CPicObjBase<never> {
  return readCPicObjBase<never>(reader, (header) => {
    throw new Error(
      `CPicObj: expected leaf but found ${header.className} at 0x${header.tagStart.toString(16)}`
    );
  });
}
