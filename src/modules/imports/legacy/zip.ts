import { crc32, inflateRawSync } from "node:zlib";
import { readZipDirectory } from "./zip-directory";

/**
 * Minimal in-memory zip handling for .xlsx uploads (no dependency, no disk):
 *
 *   (readZipDirectory, ./zip-directory.ts: the central directory without inflating anything)
 *   unpackZip         every entry inflated in memory under a real size budget (the declared sizes
 *                     of a zip bomb can lie; inflateRawSync's maxOutputLength cannot be fooled);
 *   packStoredZip     the entries again as an uncompressed zip, in the order given.
 *
 * Why repack: exceljs' streaming reader writes each worksheet to a temporary FILE when it meets the
 * sheet before the shared strings (exceljs puts them after the sheets). Repacking with the workbook
 * parts first keeps the whole read in memory, and also drops the leading "/" some exporters put on
 * part names.
 */

export class ZipLimitError extends Error {
  constructor(readonly code: "zip_bomb" | "unreadable") {
    super(code);
    this.name = "ZipLimitError";
  }
}

/** Inflates every entry in memory; throws ZipLimitError past `maxTotal` bytes or on a bad entry. */
export function unpackZip(bytes: Uint8Array, maxTotal: number): { name: string; data: Uint8Array }[] {
  const entries = readZipDirectory(bytes);
  if (!entries) throw new ZipLimitError("unreadable");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let budget = maxTotal;
  const out: { name: string; data: Uint8Array }[] = [];
  for (const e of entries) {
    if (e.name.endsWith("/")) continue; // a directory
    if (e.flags & 0x1) throw new ZipLimitError("unreadable"); // encrypted
    const at = e.localOffset;
    if (at + 30 > bytes.length || view.getUint32(at, true) !== 0x04034b50) throw new ZipLimitError("unreadable");
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const raw = bytes.subarray(start, start + e.compressedSize);
    if (raw.length !== e.compressedSize) throw new ZipLimitError("unreadable");
    let data: Uint8Array;
    if (e.method === 0) data = raw;
    else if (e.method === 8) {
      if (budget <= 0) throw new ZipLimitError("zip_bomb");
      try {
        data = inflateRawSync(raw, { maxOutputLength: budget });
      } catch (error) {
        throw new ZipLimitError(error instanceof RangeError || (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? "zip_bomb" : "unreadable");
      }
    } else throw new ZipLimitError("unreadable");
    budget -= data.length;
    if (budget < 0) throw new ZipLimitError("zip_bomb");
    out.push({ name: e.name.replace(/^\/+/, ""), data });
  }
  return out;
}

/** An uncompressed zip of `entries`, in the given order. */
export function packStoredZip(entries: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data) >>> 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, e.data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, e.data.length, true);
    dir.setUint32(24, e.data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + e.data.length;
  }
  const dirSize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** The parts exceljs' streaming reader must see before any worksheet. */
const FIRST = ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/workbook.xml", "xl/sharedStrings.xml", "xl/styles.xml"];

export function workbookPartsFirst(entries: { name: string; data: Uint8Array }[]): { name: string; data: Uint8Array }[] {
  const rank = (name: string) => {
    const i = FIRST.indexOf(name);
    return i < 0 ? FIRST.length : i;
  };
  return entries.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e.name) - rank(b.e.name) || a.i - b.i).map(({ e }) => e);
}
