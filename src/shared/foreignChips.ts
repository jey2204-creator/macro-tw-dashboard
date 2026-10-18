/**
 * 外資籌碼對照：外資買賣超（上市）× 外資台指期淨未平倉 × 散戶小台淨未平倉（推算）× 加權指數。
 *
 * 買賣超是「流量」、淨未平倉是「部位」，與當日漲跌幾乎同步；有資訊的是
 *  - 累計買賣超 vs 指數的背離（連續賣超但指數不跌、連續買超但指數不漲）
 *  - 部位落在近 250 日極端（第 5／95 百分位）
 * 因此每一筆都換算成近 250 日百分位，事件只在「首次進入極端」時標一次，
 * 回到中位數另一側（高極端 ≤ 第 50、低極端 ≥ 第 50 百分位）才算新的一波。
 *
 * 僅供參考：不計入總經分數。
 */
import { forward, mdd, stats, type EventStats } from './marginStress';
import type { Bar } from './types';

/**
 * 每日資料：[日期, 加權收盤, 外資買賣超（億）, 5 日累計, 20 日累計,
 *  外資期淨未平倉（口）, 其增減, 散戶小台淨未平倉（口）, 其增減]
 * 缺資料為 null；累計需要完整視窗才有值。
 */
export type ForeignRow = [
  date: string,
  taiex: number,
  net: number | null,
  cum5: number | null,
  cum20: number | null,
  foreignOi: number | null,
  foreignOiChg: number | null,
  retailOi: number | null,
  retailOiChg: number | null,
];

export type ForeignEventType = 'oi_short' | 'oi_long' | 'sell_extreme' | 'buy_extreme' | 'retail_long' | 'sell_no_fall';

export const PCTL_WINDOW = 250;
export const PCTL_MIN = 120;
export const EXTREME_LOW = 0.05;
export const EXTREME_HIGH = 0.95;
/** 重新武裝門檻：極端事件要等百分位回到中位數另一側才可再標 */
export const RESET_PCTL = 0.5;
/** 賣超不跌：20 日累計賣超落在第 10 百分位以下，且加權 20 日報酬 ≥ 0 */
export const DIVERGE_PCTL = 0.1;
/** 再創極端：同一波內外資期淨 OI 比前次標記值再多 10%，補一個小標記（不進回測） */
export const DEEPER_STEP = 0.1;

/** 同一波內的「再創極端」小標記：oi_short 空單再增、oi_long 多單再增 */
export interface DeeperMark {
  date: string;
  kind: 'oi_short' | 'oi_long';
  value: number;
}

export const FOREIGN_EVENT_LABEL: Record<ForeignEventType, string> = {
  oi_short: '外資期空單極端',
  oi_long: '外資期多單極端',
  sell_extreme: '20日累計賣超極端',
  buy_extreme: '20日累計買超極端',
  retail_long: '散戶小台偏多極端',
  sell_no_fall: '賣超不跌',
};
export const FOREIGN_MARKER_TEXT: Record<ForeignEventType, string> = {
  oi_short: 'OI空',
  oi_long: 'OI多',
  sell_extreme: '賣超',
  buy_extreme: '買超',
  retail_long: '散戶多',
  sell_no_fall: '賣不跌',
};

export interface ForeignEvent {
  date: string;
  type: ForeignEventType;
  taiex: number;
  /** 觸發事件的數值（口或億） */
  value: number;
  ret20: number | null;
  ret60: number | null;
  mdd60: number | null;
}

export interface ForeignChipsFile {
  schemaVersion: 1;
  generatedAt: string;
  start: string | null;
  end: string | null;
  rows: ForeignRow[];
  /** 近 250 日百分位（0～1；資料不足 null）：20 日累計買賣超、外資期淨 OI、散戶小台淨 OI */
  pctl: { cum20: (number | null)[]; foreignOi: (number | null)[]; retailOi: (number | null)[] };
  events: ForeignEvent[];
  /** 同一波內再創極端的小標記（只畫在圖上，不計入事件統計） */
  deeper: DeeperMark[];
  eventStats: Record<ForeignEventType, EventStats>;
  baseline: EventStats;
  latest: {
    date: string;
    taiex: number;
    net: number | null;
    cum5: number | null;
    cum20: number | null;
    cum20Pctl: number | null;
    foreignOi: number | null;
    foreignOiPctl: number | null;
    retailOi: number | null;
    retailOiPctl: number | null;
  } | null;
}

export const FOREIGN_EVENT_TYPES: ForeignEventType[] = ['oi_short', 'oi_long', 'sell_extreme', 'buy_extreme', 'retail_long', 'sell_no_fall'];

const r2 = (v: number) => Math.round(v * 100) / 100;

/** 合併三個籌碼序列到台股交易日；只保留至少有一項籌碼資料的日子 */
export function combineForeignRows(
  live: { net?: Bar[]; foreignOi?: Bar[]; retailOi?: Bar[] },
  taiex: Bar[],
): ForeignRow[] {
  const toMap = (bars: Bar[] | undefined) => new Map((bars ?? []).map((b) => [b[0], b[4]]));
  const net = toMap(live.net);
  const foi = toMap(live.foreignOi);
  const roi = toMap(live.retailOi);
  const pick = (m: Map<string, number>, d: string) => {
    const v = m.get(d);
    return v !== undefined && Number.isFinite(v) ? v : null;
  };
  const out: ForeignRow[] = [];
  let prevF: number | null = null;
  let prevR: number | null = null;
  const nets: (number | null)[] = [];
  for (const b of taiex) {
    const d = b[0];
    const n = pick(net, d);
    const f = pick(foi, d);
    const r = pick(roi, d);
    if (n === null && f === null && r === null) continue;
    // 累計：視窗內每一天都要有買賣超資料才算（買賣超資料起點晚於期貨，前段不補 0）
    nets.push(n);
    const cum = (k: number) => {
      if (nets.length < k) return null;
      const win = nets.slice(-k);
      return win.every((x): x is number => x !== null) ? r2(win.reduce((a, x) => a + x, 0)) : null;
    };
    out.push([
      d,
      b[4],
      n,
      cum(5),
      cum(20),
      f,
      f !== null && prevF !== null ? f - prevF : null,
      r,
      r !== null && prevR !== null ? r - prevR : null,
    ]);
    if (f !== null) prevF = f;
    if (r !== null) prevR = r;
  }
  return out;
}

/** 每日值在近 PCTL_WINDOW 筆（含當日、至少 PCTL_MIN 筆有效值）中的百分位（0～1） */
export function rollingPctl(values: (number | null)[], window = PCTL_WINDOW, min = PCTL_MIN): (number | null)[] {
  return values.map((v, i) => {
    if (v === null) return null;
    const win = values.slice(Math.max(0, i - window + 1), i + 1).filter((x): x is number => x !== null);
    if (win.length < min) return null;
    const below = win.filter((x) => x < v).length;
    const equal = win.filter((x) => x === v).length;
    return r2((below + equal / 2) / win.length);
  });
}

/**
 * 再創極端：從 oi_short／oi_long 事件起，到下一次該類事件重新武裝前，
 * 淨 OI 每比前次標記值再多 DEEPER_STEP（以前次絕對值計）就補一個標記。
 */
export function detectDeeper(rows: ForeignRow[], events: ForeignEvent[], pctl: ForeignChipsFile['pctl']): DeeperMark[] {
  const out: DeeperMark[] = [];
  const byDate = new Map(events.filter((e) => e.type === 'oi_short' || e.type === 'oi_long').map((e) => [e.date, e]));
  let ref: { kind: 'oi_short' | 'oi_long'; value: number } | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const ev = byDate.get(row[0]);
    if (ev) {
      ref = { kind: ev.type as 'oi_short' | 'oi_long', value: ev.value };
      continue;
    }
    if (!ref || row[5] === null) continue;
    const p = pctl.foreignOi[i];
    // 回到中位數另一側＝這一波結束
    if (p !== null && p !== undefined && (ref.kind === 'oi_short' ? p >= RESET_PCTL : p <= RESET_PCTL)) {
      ref = null;
      continue;
    }
    const step = Math.abs(ref.value) * DEEPER_STEP;
    const deeper = ref.kind === 'oi_short' ? row[5] <= ref.value - step : row[5] >= ref.value + step;
    if (deeper) {
      out.push({ date: row[0], kind: ref.kind, value: row[5] });
      ref = { kind: ref.kind, value: row[5] };
    }
  }
  return out;
}

export function detectForeignEvents(rows: ForeignRow[], pctl: ForeignChipsFile['pctl']): ForeignEvent[] {
  const events: ForeignEvent[] = [];
  const armed: Record<ForeignEventType, boolean> = {
    oi_short: true,
    oi_long: true,
    sell_extreme: true,
    buy_extreme: true,
    retail_long: true,
    sell_no_fall: true,
  };
  const emit = (i: number, type: ForeignEventType, value: number) => {
    armed[type] = false;
    events.push({
      date: rows[i]![0],
      type,
      taiex: rows[i]![1],
      value,
      ret20: forward(rows, i, 20),
      ret60: forward(rows, i, 60),
      mdd60: mdd(rows, i, 60),
    });
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const pf = pctl.foreignOi[i];
    const pc = pctl.cum20[i];
    const pr = pctl.retailOi[i];
    const atLeast = (p: number | null | undefined) => p !== null && p !== undefined && p >= RESET_PCTL;
    const atMost = (p: number | null | undefined) => p !== null && p !== undefined && p <= RESET_PCTL;
    if (atLeast(pf)) armed.oi_short = true;
    if (atMost(pf)) armed.oi_long = true;
    if (atLeast(pc)) armed.sell_extreme = armed.sell_no_fall = true;
    if (atMost(pc)) armed.buy_extreme = true;
    if (atMost(pr)) armed.retail_long = true;

    if (pf !== null && pf !== undefined && row[5] !== null) {
      if (pf <= EXTREME_LOW && armed.oi_short) emit(i, 'oi_short', row[5]);
      if (pf >= EXTREME_HIGH && armed.oi_long) emit(i, 'oi_long', row[5]);
    }
    if (pc !== null && pc !== undefined && row[4] !== null) {
      if (pc <= EXTREME_LOW && armed.sell_extreme) emit(i, 'sell_extreme', row[4]);
      if (pc >= EXTREME_HIGH && armed.buy_extreme) emit(i, 'buy_extreme', row[4]);
      const ret20 = i >= 20 ? row[1] / rows[i - 20]![1] - 1 : null;
      if (pc <= DIVERGE_PCTL && ret20 !== null && ret20 >= 0 && armed.sell_no_fall) emit(i, 'sell_no_fall', row[4]);
    }
    if (pr !== null && pr !== undefined && row[7] !== null && pr >= EXTREME_HIGH && armed.retail_long) emit(i, 'retail_long', row[7]);
  }
  return events;
}

export function analyzeForeignChips(rows: ForeignRow[], now = new Date()): ForeignChipsFile {
  const pctl = {
    cum20: rollingPctl(rows.map((r) => r[4])),
    foreignOi: rollingPctl(rows.map((r) => r[5])),
    retailOi: rollingPctl(rows.map((r) => r[7])),
  };
  const events = detectForeignEvents(rows, pctl);
  const deeper = detectDeeper(rows, events, pctl);
  const perDay = rows.map((_, i) => ({ ret20: forward(rows, i, 20), ret60: forward(rows, i, 60), mdd60: mdd(rows, i, 60) }));
  const eventStats = Object.fromEntries(FOREIGN_EVENT_TYPES.map((t) => [t, stats(events.filter((e) => e.type === t))])) as Record<
    ForeignEventType,
    EventStats
  >;
  const last = rows.length - 1;
  const l = rows[last];
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    start: rows[0]?.[0] ?? null,
    end: l?.[0] ?? null,
    rows,
    pctl,
    events,
    deeper,
    eventStats,
    baseline: stats(perDay),
    latest: l
      ? {
          date: l[0],
          taiex: l[1],
          net: l[2],
          cum5: l[3],
          cum20: l[4],
          cum20Pctl: pctl.cum20[last] ?? null,
          foreignOi: l[5],
          foreignOiPctl: pctl.foreignOi[last] ?? null,
          retailOi: l[7],
          retailOiPctl: pctl.retailOi[last] ?? null,
        }
      : null,
  };
}
