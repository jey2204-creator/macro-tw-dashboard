import { inflateSync } from 'node:zlib';

/**
 * 最小的 PDF 文字擷取：取出每個字的位置（使用者座標，y 向上），再組成「行／詞」。
 * MSCI 指數 factsheet 只提供 PDF（Apache FOP 產生），專案不想為此引入 pdf.js 這類大型套件。
 *
 * 支援：未加密、無物件串流（/ObjStm）的 PDF；FlateDecode 串流；Type0（Identity-H，2 位元組編碼）
 * 與簡單字型（1 位元組）；有 /ToUnicode 時以它對應 Unicode，否則簡單字型以 Latin-1 近似。
 * 內容串流只解讀定位與文字相關運算子（q Q cm BT ET Tf Tm Td TD T* TL Tc Tw Tz TJ Tj ' "），
 * 字寬取自字型的 /W（CID）或 /Widths（簡單字型），用來推算同一個 TJ 內各字的位置。
 */

export interface PdfGlyph {
  page: number;
  x: number;
  y: number;
  /** 字的寬度（使用者座標） */
  w: number;
  size: number;
  ch: string;
}

export interface PdfWord {
  text: string;
  x0: number;
  x1: number;
  y: number;
  size: number;
}

export interface PdfLine {
  page: number;
  y: number;
  words: PdfWord[];
  /** 詞以單一空白連接 */
  text: string;
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
/** m1 × m2（PDF 列向量慣例：先套 m1 再套 m2） */
const mul = (m1: Matrix, m2: Matrix): Matrix => [
  m1[0] * m2[0] + m1[1] * m2[2],
  m1[0] * m2[1] + m1[1] * m2[3],
  m1[2] * m2[0] + m1[3] * m2[2],
  m1[2] * m2[1] + m1[3] * m2[3],
  m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
  m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
];

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1');

// ── 物件與串流 ──────────────────────────────────────────────

interface PdfObject {
  dict: string;
  stream: Uint8Array | null;
}

function parseObjects(buf: Uint8Array): Map<number, PdfObject> {
  const text = latin1(buf);
  const out = new Map<number, PdfObject>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = text.indexOf('endobj', start);
    if (end < 0) break;
    const body = text.slice(start, end);
    const si = body.search(/\bstream\r?\n/);
    if (si < 0) {
      out.set(num, { dict: body, stream: null });
    } else {
      const dict = body.slice(0, si);
      let dataStart = start + si + 'stream'.length;
      if (text[dataStart] === '\r') dataStart++;
      if (text[dataStart] === '\n') dataStart++;
      const lenM = /\/Length\s+(\d+)(\s+\d+\s+R)?/.exec(dict);
      let len = -1;
      if (lenM && !lenM[2]) len = Number(lenM[1]);
      const es = text.lastIndexOf('endstream', end);
      if (len < 0 || dataStart + len > es) len = es - dataStart;
      out.set(num, { dict, stream: buf.subarray(dataStart, dataStart + len) });
    }
    re.lastIndex = end;
  }
  if ([...out.values()].some((o) => /\/Type\s*\/ObjStm/.test(o.dict))) throw new Error('PDF 使用物件串流（ObjStm），不支援');
  return out;
}

function decodeStream(o: PdfObject | undefined): Uint8Array {
  if (!o?.stream) return new Uint8Array(0);
  if (/\/Filter\s*\[?\s*\/FlateDecode/.test(o.dict)) {
    try {
      return new Uint8Array(inflateSync(o.stream));
    } catch {
      // 長度含了換行等多餘位元組：去掉尾端空白再試
      let n = o.stream.length;
      while (n > 0 && (o.stream[n - 1] === 0x0a || o.stream[n - 1] === 0x0d || o.stream[n - 1] === 0x20)) n--;
      return new Uint8Array(inflateSync(o.stream.subarray(0, n)));
    }
  }
  if (/\/Filter/.test(o.dict)) return new Uint8Array(0); // 其他壓縮（影像等）不需要
  return o.stream;
}

const ref = (dict: string, key: string): number | null => {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return m ? Number(m[1]) : null;
};

/** 取出 /Key << ... >> 的內容（處理巢狀） */
function subDict(dict: string, key: string): string | null {
  const i = dict.search(new RegExp(`/${key}\\s*<<`));
  if (i < 0) return null;
  let p = dict.indexOf('<<', i) + 2;
  const start = p;
  let depth = 1;
  while (p < dict.length && depth > 0) {
    if (dict.startsWith('<<', p)) {
      depth++;
      p += 2;
    } else if (dict.startsWith('>>', p)) {
      depth--;
      p += 2;
    } else p++;
  }
  return dict.slice(start, p - 2);
}

// ── 字型 ────────────────────────────────────────────────────

interface Font {
  twoByte: boolean;
  toUnicode: Map<number, string>;
  widths: Map<number, number>;
  defaultWidth: number;
}

function hexToUtf16(hex: string): string {
  let s = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  if (hex.length === 2) s = String.fromCharCode(parseInt(hex, 16));
  return s;
}

export function parseCMap(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1]!, 16), hexToUtf16(m[2]!));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1]!, 16);
      const hi = parseInt(m[2]!, 16);
      if (m[3]!.startsWith('[')) {
        const list = [...m[3]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => hexToUtf16(x[1]!));
        for (let c = lo; c <= hi && c - lo < list.length; c++) map.set(c, list[c - lo]!);
      } else {
        const base = m[3]!.slice(1, -1);
        const head = base.slice(0, -4);
        const last = parseInt(base.slice(-4) || '0', 16);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, hexToUtf16(head) + String.fromCharCode(last + c - lo));
      }
    }
  }
  return map;
}

/** CID 字型 /W：[c [w1 w2 …] c1 c2 w …] */
function parseCidWidths(w: string, out: Map<number, number>) {
  const toks = w.match(/\[|\]|-?\d+(?:\.\d+)?/g) ?? [];
  let i = 0;
  while (i < toks.length) {
    const c = Number(toks[i++]);
    if (toks[i] === '[') {
      i++;
      let k = 0;
      while (i < toks.length && toks[i] !== ']') out.set(c + k++, Number(toks[i++]));
      i++;
    } else if (i + 1 < toks.length) {
      const c2 = Number(toks[i++]);
      const wv = Number(toks[i++]);
      for (let k = c; k <= c2 && k - c < 65536; k++) out.set(k, wv);
    } else break;
  }
}

function bracketAfter(dict: string, key: string): string | null {
  const i = dict.search(new RegExp(`/${key}\\s*\\[`));
  if (i < 0) return null;
  let p = dict.indexOf('[', i);
  const start = p;
  let depth = 0;
  for (; p < dict.length; p++) {
    if (dict[p] === '[') depth++;
    else if (dict[p] === ']') {
      depth--;
      if (depth === 0) return dict.slice(start + 1, p);
    }
  }
  return null;
}

function loadFont(objs: Map<number, PdfObject>, num: number): Font {
  const o = objs.get(num);
  const dict = o?.dict ?? '';
  const twoByte = /\/Subtype\s*\/Type0/.test(dict);
  const tu = ref(dict, 'ToUnicode');
  const toUnicode = tu !== null ? parseCMap(latin1(decodeStream(objs.get(tu)))) : new Map<number, string>();
  const widths = new Map<number, number>();
  let defaultWidth = twoByte ? 1000 : 500;
  if (twoByte) {
    const df = /\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/.exec(dict);
    const dd = df ? (objs.get(Number(df[1]))?.dict ?? '') : '';
    const dw = /\/DW\s+(\d+)/.exec(dd);
    if (dw) defaultWidth = Number(dw[1]);
    const w = bracketAfter(dd, 'W');
    if (w) parseCidWidths(w, widths);
  } else {
    const first = Number(/\/FirstChar\s+(\d+)/.exec(dict)?.[1] ?? 0);
    let w = bracketAfter(dict, 'Widths');
    const wr = ref(dict, 'Widths');
    if (!w && wr !== null) w = (objs.get(wr)?.dict ?? '').replace(/^[^[]*\[|\][^\]]*$/g, '');
    (w?.match(/-?\d+(?:\.\d+)?/g) ?? []).forEach((v, k) => widths.set(first + k, Number(v)));
  }
  return { twoByte, toUnicode, widths, defaultWidth };
}

// ── 內容串流 ────────────────────────────────────────────────

type Tok = number | string | { name: string } | { str: Uint8Array } | Tok[];

function tokenize(src: Uint8Array): Tok[] {
  const out: Tok[] = [];
  const stack: Tok[][] = [];
  const push = (t: Tok) => (stack.length ? stack[stack.length - 1]!.push(t) : out.push(t));
  const n = src.length;
  let i = 0;
  const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
  const isDelim = (c: number) => c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
  while (i < n) {
    const c = src[i]!;
    if (isWs(c)) {
      i++;
    } else if (c === 0x25) {
      while (i < n && src[i] !== 0x0a && src[i] !== 0x0d) i++;
    } else if (c === 0x5b) {
      stack.push([]);
      i++;
    } else if (c === 0x5d) {
      const arr = stack.pop() ?? [];
      push(arr);
      i++;
    } else if (c === 0x28) {
      // 字面字串（可巢狀括號、反斜線跳脫）
      const bytes: number[] = [];
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const ch = src[i]!;
        if (ch === 0x5c) {
          const nx = src[i + 1]!;
          const map: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
          if (nx in map) {
            bytes.push(map[nx]!);
            i += 2;
          } else if (nx >= 0x30 && nx <= 0x37) {
            let o = 0;
            let k = 0;
            i++;
            while (k < 3 && src[i]! >= 0x30 && src[i]! <= 0x37) {
              o = o * 8 + (src[i]! - 0x30);
              i++;
              k++;
            }
            bytes.push(o & 0xff);
          } else if (nx === 0x0d || nx === 0x0a) {
            i += 2;
            if (nx === 0x0d && src[i] === 0x0a) i++;
          } else {
            bytes.push(nx);
            i += 2;
          }
        } else {
          if (ch === 0x28) depth++;
          else if (ch === 0x29) depth--;
          if (depth > 0) bytes.push(ch);
          i++;
        }
      }
      push({ str: Uint8Array.from(bytes) });
    } else if (c === 0x3c && src[i + 1] === 0x3c) {
      // 字典（BDC 的屬性等）：略過
      let depth = 0;
      while (i < n) {
        if (src[i] === 0x3c && src[i + 1] === 0x3c) {
          depth++;
          i += 2;
        } else if (src[i] === 0x3e && src[i + 1] === 0x3e) {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else i++;
      }
      push({ name: '<<dict>>' });
    } else if (c === 0x3c) {
      let hex = '';
      i++;
      while (i < n && src[i] !== 0x3e) {
        if (!isWs(src[i]!)) hex += String.fromCharCode(src[i]!);
        i++;
      }
      i++;
      if (hex.length % 2) hex += '0';
      push({ str: Uint8Array.from(Buffer.from(hex, 'hex')) });
    } else if (c === 0x2f) {
      let s = '';
      i++;
      while (i < n && !isWs(src[i]!) && !isDelim(src[i]!)) s += String.fromCharCode(src[i++]!);
      push({ name: s });
    } else {
      let s = '';
      while (i < n && !isWs(src[i]!) && !isDelim(src[i]!)) s += String.fromCharCode(src[i++]!);
      if (s === '') {
        i++;
        continue;
      }
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) push(Number(s));
      else if (s === 'BI') {
        // 行內影像：跳到 EI
        const rest = latin1(src.subarray(i));
        const e = rest.search(/\sEI(\s|$)/);
        i += e < 0 ? rest.length : e + 3;
      } else push(s);
    }
  }
  return out;
}

function interpret(content: Uint8Array, fonts: Map<string, Font>, page: number, out: PdfGlyph[]) {
  const toks = tokenize(content);
  let ctm: Matrix = [...IDENTITY];
  const gstack: Matrix[] = [];
  let tm: Matrix = [...IDENTITY];
  let tlm: Matrix = [...IDENTITY];
  let font: Font | null = null;
  let size = 0;
  let tc = 0;
  let tw = 0;
  let th = 1;
  let tl = 0;
  const ops: Tok[] = [];
  const num = (k: number) => (typeof ops[ops.length - k] === 'number' ? (ops[ops.length - k] as number) : 0);

  const show = (bytes: Uint8Array) => {
    if (!font) return;
    const step = font.twoByte ? 2 : 1;
    for (let k = 0; k + step <= bytes.length; k += step) {
      const code = step === 2 ? (bytes[k]! << 8) | bytes[k + 1]! : bytes[k]!;
      const ch = font.toUnicode.get(code) ?? (font.twoByte ? '' : String.fromCharCode(code));
      const w0 = (font.widths.get(code) ?? font.defaultWidth) / 1000;
      const m = mul(tm, ctm);
      const scale = Math.hypot(m[0], m[1]);
      const adv = (w0 * size + tc + (code === 32 && step === 1 ? tw : 0)) * th;
      if (ch && ch !== '￿') out.push({ page, x: m[4], y: m[5], w: w0 * size * th * scale, size: size * Math.hypot(m[2], m[3]), ch });
      tm = mul([1, 0, 0, 1, adv, 0], tm);
    }
  };

  for (const t of toks) {
    if (typeof t !== 'string') {
      ops.push(t);
      continue;
    }
    switch (t) {
      case 'q':
        gstack.push(ctm);
        break;
      case 'Q':
        ctm = gstack.pop() ?? [...IDENTITY];
        break;
      case 'cm':
        ctm = mul([num(6), num(5), num(4), num(3), num(2), num(1)], ctm);
        break;
      case 'BT':
        tm = [...IDENTITY];
        tlm = [...IDENTITY];
        break;
      case 'Tf': {
        const name = ops[ops.length - 2];
        font = typeof name === 'object' && 'name' in name ? (fonts.get(name.name) ?? null) : null;
        size = num(1);
        break;
      }
      case 'Tm':
        tm = [num(6), num(5), num(4), num(3), num(2), num(1)];
        tlm = [...tm];
        break;
      case 'Td':
        tlm = mul([1, 0, 0, 1, num(2), num(1)], tlm);
        tm = [...tlm];
        break;
      case 'TD':
        tl = -num(1);
        tlm = mul([1, 0, 0, 1, num(2), num(1)], tlm);
        tm = [...tlm];
        break;
      case 'T*':
        tlm = mul([1, 0, 0, 1, 0, -tl], tlm);
        tm = [...tlm];
        break;
      case 'TL':
        tl = num(1);
        break;
      case 'Tc':
        tc = num(1);
        break;
      case 'Tw':
        tw = num(1);
        break;
      case 'Tz':
        th = num(1) / 100;
        break;
      case 'Tj': {
        const s = ops[ops.length - 1];
        if (typeof s === 'object' && 'str' in s) show(s.str);
        break;
      }
      case "'":
      case '"': {
        if (t === '"') {
          tw = num(3);
          tc = num(2);
        }
        tlm = mul([1, 0, 0, 1, 0, -tl], tlm);
        tm = [...tlm];
        const s = ops[ops.length - 1];
        if (typeof s === 'object' && 'str' in s) show(s.str);
        break;
      }
      case 'TJ': {
        const arr = ops[ops.length - 1];
        if (Array.isArray(arr)) {
          for (const el of arr) {
            if (typeof el === 'number') tm = mul([1, 0, 0, 1, (-el / 1000) * size * th, 0], tm);
            else if (typeof el === 'object' && 'str' in el) show(el.str);
          }
        }
        break;
      }
    }
    ops.length = 0;
  }
}

/** 依頁面順序取出所有字 */
export function pdfGlyphs(buf: Uint8Array): PdfGlyph[] {
  const objs = parseObjects(buf);
  // 頁面順序：Catalog → Pages → Kids（遞迴）
  const pages: number[] = [];
  const catalog = [...objs.entries()].find(([, o]) => /\/Type\s*\/Catalog/.test(o.dict));
  const walk = (n: number, depth = 0) => {
    const d = objs.get(n)?.dict ?? '';
    if (depth > 20) return;
    if (/\/Type\s*\/Pages/.test(d)) {
      const kids = bracketAfter(d, 'Kids') ?? '';
      for (const k of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(k[1]), depth + 1);
    } else if (/\/Type\s*\/Page\b/.test(d)) pages.push(n);
  };
  const root = catalog ? ref(catalog[1].dict, 'Pages') : null;
  if (root !== null) walk(root);
  if (pages.length === 0) {
    for (const [n, o] of objs) if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push(n);
  }
  const fontCache = new Map<number, Font>();
  const out: PdfGlyph[] = [];
  pages.forEach((pn, idx) => {
    const pd = objs.get(pn)!.dict;
    const resRef = ref(pd, 'Resources');
    const res = resRef !== null ? (objs.get(resRef)?.dict ?? '') : (subDict(pd, 'Resources') ?? '');
    const fontDict = subDict(res, 'Font') ?? (ref(res, 'Font') !== null ? (objs.get(ref(res, 'Font')!)?.dict ?? '') : '');
    const fonts = new Map<string, Font>();
    for (const m of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const n = Number(m[2]);
      if (!fontCache.has(n)) fontCache.set(n, loadFont(objs, n));
      fonts.set(m[1]!, fontCache.get(n)!);
    }
    const contents: number[] = [];
    const cArr = bracketAfter(pd, 'Contents');
    if (cArr) for (const k of cArr.matchAll(/(\d+)\s+\d+\s+R/g)) contents.push(Number(k[1]));
    else {
      const c = ref(pd, 'Contents');
      if (c !== null) contents.push(c);
    }
    const parts = contents.map((c) => decodeStream(objs.get(c)));
    const total = new Uint8Array(parts.reduce((a, p) => a + p.length + 1, 0));
    let off = 0;
    for (const p of parts) {
      total.set(p, off);
      off += p.length;
      total[off++] = 0x0a;
    }
    interpret(total, fonts, idx + 1, out);
  });
  return out;
}

/** 字 → 行（同頁、基線相近）→ 詞（間距超過約 0.25 字高或遇到空白就斷開） */
export function pdfLines(buf: Uint8Array): PdfLine[] {
  const glyphs = pdfGlyphs(buf);
  const lines: { page: number; y: number; gs: PdfGlyph[] }[] = [];
  for (const g of glyphs) {
    const tol = Math.max(1, g.size * 0.3);
    let line = lines.find((l) => l.page === g.page && Math.abs(l.y - g.y) <= tol);
    if (!line) {
      line = { page: g.page, y: g.y, gs: [] };
      lines.push(line);
    }
    line.gs.push(g);
  }
  const out: PdfLine[] = [];
  for (const l of lines) {
    l.gs.sort((a, b) => a.x - b.x);
    const words: PdfWord[] = [];
    let cur: PdfWord | null = null;
    for (const g of l.gs) {
      if (g.ch.trim() === '') {
        cur = null;
        continue;
      }
      const gap = cur ? g.x - cur.x1 : Infinity;
      if (cur && gap <= Math.max(0.6, g.size * 0.22) && gap > -g.size) {
        cur.text += g.ch;
        cur.x1 = Math.max(cur.x1, g.x + g.w);
      } else {
        cur = { text: g.ch, x0: g.x, x1: g.x + g.w, y: g.y, size: g.size };
        words.push(cur);
      }
    }
    if (words.length) out.push({ page: l.page, y: l.y, words, text: words.map((w) => w.text).join(' ') });
  }
  // 頁面順序，頁內由上而下（y 大到小）
  return out.sort((a, b) => a.page - b.page || b.y - a.y);
}
