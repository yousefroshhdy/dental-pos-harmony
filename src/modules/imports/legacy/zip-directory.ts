/**
 * The central directory of a zip (an .xlsx is one), read without inflating anything. Pure (no Node
 * APIs), so the upload checks can share it; inflating lives in ./zip.ts (server only).
 */

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/** Null when the bytes are not a well-formed zip (ZIP64 is treated as not well-formed). */
export function readZipDirectory(bytes: Uint8Array): ZipEntry[] | null {
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is last, followed by a comment of at most 65535 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const total = view.getUint16(eocd + 10, true);
  const dirSize = view.getUint32(eocd + 12, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  if (total === 0xffff || dirOffset === 0xffffffff || dirOffset + dirSize > eocd) return null;

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries: ZipEntry[] = [];
  let p = dirOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) return null;
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    if (p + 46 + nameLength > bytes.length) return null;
    entries.push({
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)),
      flags: view.getUint16(p + 8, true),
      method: view.getUint16(p + 10, true),
      crc: view.getUint32(p + 16, true),
      compressedSize: view.getUint32(p + 20, true),
      uncompressedSize: view.getUint32(p + 24, true),
      localOffset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
