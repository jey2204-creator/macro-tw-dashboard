/**
 * 最小的舊版 Excel（.xls）讀取器：只取各工作表的儲存格文字與數值，不處理格式。
 * 證交所「證券市場統計概要」月報只提供 xls（zip 包裝），專案不想為此引入第三方套件。
 *
 * 結構：.xls 是 OLE 複合文件（CFB），裡面的「Workbook」（BIFF8，Excel 97 起）或「Book」（BIFF5/7）串流
 * 是一連串記錄：[類型 u16][長度 u16][內容]。用到的記錄：
 *  - BOF 0x0809、EOF 0x000A、BOUNDSHEET 0x0085（工作表名稱與位置）、CODEPAGE 0x0042
 *  - SST 0x00FC＋CONTINUE 0x003C（BIFF8 共用字串表）、LABELSST 0x00FD
 *  - LABEL 0x0204、RSTRING 0x00D6（BIFF5 字串）、NUMBER 0x0203、RK 0x027E、MULRK 0x00BD、FORMULA 0x0006＋STRING 0x0207
 */

export type XlsCell = string | number | null;
export interface XlsSheet {
  name: string;
  /** rows[r][c]；沒有值的位置為 null */
  rows: XlsCell[][];
}

const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECT = 0xffffffff;

interface DirEntry {
  name: string;
  type: number;
  start: number;
  size: number;
}

/** 讀取 CFB 內指定名稱的串流 */
export function cfbStream(buf: Uint8Array, names: readonly string[]): Uint8Array | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 512 || SIG.some((b, i) => buf[i] !== b)) throw new Error('不是 xls（OLE 複合文件）');
  const sectorSize = 1 << dv.getUint16(0x1e, true);
  const miniSectorSize = 1 << dv.getUint16(0x20, true);
  const dirStart = dv.getUint32(0x30, true);
  const miniCutoff = dv.getUint32(0x38, true);
  const miniFatStart = dv.getUint32(0x3c, true);
  const difStart = dv.getUint32(0x44, true);
  const difCount = dv.getUint32(0x48, true);

  const sectorOffset = (n: number) => (n + 1) * sectorSize;
  // FAT 所在的磁區：表頭 109 個，其餘在 DIFAT 鏈
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = dv.getUint32(0x4c + i * 4, true);
    if (s !== FREE_SECT) fatSectors.push(s);
  }
  let dif = difStart;
  for (let k = 0; k < difCount && dif !== END_OF_CHAIN && dif !== FREE_SECT; k++) {
    const off = sectorOffset(dif);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per; i++) {
      const s = dv.getUint32(off + i * 4, true);
      if (s !== FREE_SECT) fatSectors.push(s);
    }
    dif = dv.getUint32(off + per * 4, true);
  }
  const fat: number[] = [];
  for (const s of fatSectors) {
    const off = sectorOffset(s);
    if (off + sectorSize > buf.length) break;
    for (let i = 0; i < sectorSize / 4; i++) fat.push(dv.getUint32(off + i * 4, true));
  }
  const chain = (start: number): number[] => {
    const out: number[] = [];
    let s = start;
    while (s !== END_OF_CHAIN && s !== FREE_SECT && s < fat.length && out.length <= fat.length) {
      out.push(s);
      s = fat[s]!;
    }
    return out;
  };
  const readChain = (start: number, size: number): Uint8Array => {
    const out = new Uint8Array(size);
    let pos = 0;
    for (const s of chain(start)) {
      if (pos >= size) break;
      const off = sectorOffset(s);
      const n = Math.min(sectorSize, size - pos, buf.length - off);
      if (n <= 0) break;
      out.set(buf.subarray(off, off + n), pos);
      pos += n;
    }
    return out;
  };

  // 目錄
  const dirSectors = chain(dirStart);
  const dirBytes = readChain(dirStart, dirSectors.length * sectorSize);
  const ddv = new DataView(dirBytes.buffer);
  const entries: DirEntry[] = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const nameLen = ddv.getUint16(off + 64, true);
    const type = dirBytes[off + 66]!;
    if (type === 0 || nameLen < 2) continue;
    let name = '';
    for (let i = 0; i < nameLen / 2 - 1; i++) name += String.fromCharCode(ddv.getUint16(off + i * 2, true));
    entries.push({ name, type, start: ddv.getUint32(off + 116, true), size: ddv.getUint32(off + 120, true) });
  }
  const root = entries.find((e) => e.type === 5);
  const target = entries.find((e) => e.type === 2 && names.some((n) => n.toLowerCase() === e.name.toLowerCase()));
  if (!target) return null;
  if (target.size >= miniCutoff || !root) return readChain(target.start, target.size);

  // 小串流：放在根目錄的 mini stream 內，以 mini FAT 串接
  const miniStream = readChain(root.start, root.size);
  const miniFatSectors = chain(miniFatStart);
  const miniFatBytes = readChain(miniFatStart, miniFatSectors.length * sectorSize);
  const mdv = new DataView(miniFatBytes.buffer);
  const miniFat: number[] = [];
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(mdv.getUint32(i, true));
  const out = new Uint8Array(target.size);
  let pos = 0;
  let s = target.start;
  while (s !== END_OF_CHAIN && s !== FREE_SECT && pos < target.size && s < miniFat.length) {
    const off = s * miniSectorSize;
    const n = Math.min(miniSectorSize, target.size - pos);
    out.set(miniStream.subarray(off, off + n), pos);
    pos += n;
    s = miniFat[s]!;
  }
  return out;
}

/** RK 數值：低 2 位元為旗標（bit0 ÷100、bit1 整數） */
export function decodeRk(rk: number): number {
  let v: number;
  if (rk & 0x02) v = rk >> 2;
  else {
    const b = new DataView(new ArrayBuffer(8));
    b.setUint32(4, rk & 0xfffffffc, true);
    b.setUint32(0, 0, true);
    v = b.getFloat64(0, true);
  }
  return rk & 0x01 ? v / 100 : v;
}

function decoderFor(codepage: number): TextDecoder {
  try {
    if (codepage === 950) return new TextDecoder('big5');
    if (codepage === 1200 || codepage === 1201) return new TextDecoder('utf-16le');
  } catch {
    /* 不支援的編碼退回 latin1 */
  }
  return new TextDecoder('latin1');
}

/** 跨 CONTINUE 記錄讀取 SST：字元跨記錄時，下一段開頭多一個「是否雙位元組」旗標 */
class SegReader {
  private seg = 0;
  private pos = 0;
  constructor(private readonly segs: readonly Uint8Array[]) {}
  private ensure(): boolean {
    while (this.seg < this.segs.length && this.pos >= this.segs[this.seg]!.length) {
      this.seg++;
      this.pos = 0;
    }
    return this.seg < this.segs.length;
  }
  u8(): number {
    if (!this.ensure()) throw new Error('SST 資料不足');
    return this.segs[this.seg]![this.pos++]!;
  }
  u16(): number {
    return this.u8() | (this.u8() << 8);
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  skip(n: number) {
    for (let i = 0; i < n; i++) this.u8();
  }
  /** 讀 cch 個字元；字元跨到下一段（CONTINUE）時，該段開頭是新的「是否雙位元組」旗標 */
  chars(cch: number, highByte: boolean): string {
    let out = '';
    let high = highByte;
    for (let i = 0; i < cch; i++) {
      if (this.seg < this.segs.length && this.pos >= this.segs[this.seg]!.length) {
        this.seg++;
        this.pos = 0;
        if (!this.ensure()) throw new Error('SST 字串不足');
        high = (this.u8() & 0x01) === 1;
      }
      out += String.fromCharCode(high ? this.u16() : this.u8());
    }
    return out;
  }
}

function parseSst(segs: Uint8Array[]): string[] {
  const r = new SegReader(segs);
  r.u32(); // 總數
  const unique = r.u32();
  const out: string[] = [];
  for (let k = 0; k < unique; k++) {
    try {
      const cch = r.u16();
      const flags = r.u8();
      const rich = flags & 0x08 ? r.u16() : 0;
      const ext = flags & 0x04 ? r.u32() : 0;
      out.push(r.chars(cch, (flags & 0x01) === 1));
      r.skip(rich * 4 + ext);
    } catch {
      break;
    }
  }
  return out;
}

/** 解析整份 .xls；只支援 BIFF5／BIFF8（Excel 5.0 以後） */
export function readXls(buf: Uint8Array): XlsSheet[] {
  const stream = cfbStream(buf, ['Workbook', 'Book']);
  if (!stream) throw new Error('xls 內找不到 Workbook 串流');
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const rec = (off: number) => ({ type: dv.getUint16(off, true), len: dv.getUint16(off + 2, true) });

  // 第一輪：全域區（BOF 版本、編碼、工作表清單、SST）
  let biff8 = true;
  let codepage = 1252;
  const sheetsInfo: { name: string; pos: number }[] = [];
  let sst: string[] = [];
  {
    let off = 0;
    let first = true;
    while (off + 4 <= stream.length) {
      const { type, len } = rec(off);
      const body = stream.subarray(off + 4, off + 4 + len);
      if (first && (type & 0xff) === 0x09) {
        biff8 = len >= 2 && (body[0]! | (body[1]! << 8)) === 0x0600;
        first = false;
      } else if (type === 0x0042 && len >= 2) {
        codepage = body[0]! | (body[1]! << 8);
      } else if (type === 0x0085 && len >= 8) {
        const pos = (body[0]! | (body[1]! << 8) | (body[2]! << 16) | (body[3]! << 24)) >>> 0;
        const cch = body[6]!;
        let name: string;
        if (biff8) {
          const high = (body[7]! & 0x01) === 1;
          name = '';
          for (let i = 0; i < cch; i++) name += String.fromCharCode(high ? body[8 + i * 2]! | (body[9 + i * 2]! << 8) : body[8 + i]!);
        } else {
          name = decoderFor(codepage).decode(body.subarray(7, 7 + cch));
        }
        sheetsInfo.push({ name, pos });
      } else if (type === 0x00fc) {
        const segs: Uint8Array[] = [body];
        let n = off + 4 + len;
        while (n + 4 <= stream.length && rec(n).type === 0x003c) {
          const c = rec(n);
          segs.push(stream.subarray(n + 4, n + 4 + c.len));
          n += 4 + c.len;
        }
        sst = parseSst(segs);
      } else if (type === 0x000a) {
        break; // 全域區結束
      }
      off += 4 + len;
    }
  }
  const dec = decoderFor(codepage);

  // 第二輪：各工作表
  const out: XlsSheet[] = [];
  for (const info of sheetsInfo) {
    const rows: XlsCell[][] = [];
    const put = (r: number, c: number, v: XlsCell) => {
      while (rows.length <= r) rows.push([]);
      const row = rows[r]!;
      while (row.length <= c) row.push(null);
      row[c] = v;
    };
    let off = info.pos;
    let pendingFormula: { r: number; c: number } | null = null;
    let depth = 0;
    while (off + 4 <= stream.length) {
      const { type, len } = rec(off);
      const b = off + 4;
      if ((type & 0xff) === 0x09 && (type === 0x0809 || type === 0x0409 || type === 0x0209 || type === 0x0009)) depth++;
      else if (type === 0x000a) {
        depth--;
        if (depth <= 0) break;
      } else if (depth === 1) {
        const r = len >= 2 ? dv.getUint16(b, true) : 0;
        const c = len >= 4 ? dv.getUint16(b + 2, true) : 0;
        switch (type) {
          case 0x00fd: // LABELSST
            put(r, c, sst[dv.getUint32(b + 6, true)] ?? null);
            break;
          case 0x0203: // NUMBER
            put(r, c, dv.getFloat64(b + 6, true));
            break;
          case 0x027e: // RK
            put(r, c, decodeRk(dv.getUint32(b + 6, true)));
            break;
          case 0x00bd: {
            // MULRK：row, colFirst, [ixfe, rk]*, colLast
            const last = dv.getUint16(b + len - 2, true);
            for (let col = c, p = b + 4; col <= last && p + 6 <= b + len - 2; col++, p += 6) put(r, col, decodeRk(dv.getUint32(p + 2, true)));
            break;
          }
          case 0x0204: // LABEL
          case 0x00d6: {
            // RSTRING（BIFF5）
            const cch = dv.getUint16(b + 6, true);
            if (biff8) {
              const high = (stream[b + 8]! & 0x01) === 1;
              let s = '';
              for (let i = 0; i < cch; i++) s += String.fromCharCode(high ? dv.getUint16(b + 9 + i * 2, true) : stream[b + 9 + i]!);
              put(r, c, s);
            } else {
              put(r, c, dec.decode(stream.subarray(b + 8, b + 8 + cch)));
            }
            break;
          }
          case 0x0006: {
            // FORMULA：結果 8 位元組；最後兩位元組 0xFFFF 表示非數值（字串結果在下一個 STRING 記錄）
            const isNum = dv.getUint16(b + 12, true) !== 0xffff;
            if (isNum) put(r, c, dv.getFloat64(b + 6, true));
            else if (stream[b + 6] === 0) pendingFormula = { r, c };
            break;
          }
          case 0x0207: {
            // STRING（公式的字串結果）
            if (pendingFormula) {
              const cch = dv.getUint16(b, true);
              let s: string;
              if (biff8) {
                const high = (stream[b + 2]! & 0x01) === 1;
                s = '';
                for (let i = 0; i < cch; i++) s += String.fromCharCode(high ? dv.getUint16(b + 3 + i * 2, true) : stream[b + 3 + i]!);
              } else s = dec.decode(stream.subarray(b + 2, b + 2 + cch));
              put(pendingFormula.r, pendingFormula.c, s);
              pendingFormula = null;
            }
            break;
          }
        }
      }
      off += 4 + len;
    }
    out.push({ name: info.name, rows });
  }
  return out;
}
