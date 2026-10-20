import { addMonths, monthKey } from './dates';
import { median } from './usValuation';
import { valueAtOrBefore, type Point } from './timeseries';

/**
 * MSCI 台灣指數 factsheet 的月底估值紀錄（public/data/msci-tw.json）。
 * 歷史：2021 起 Wayback 存檔（不連續的 14 個月份），之後每月累積一筆。
 */

export interface MsciRecord {
  /** 資料日（月底最後一個交易日） */
  asOf: string;
  /** 預估本益比（價格 ÷ 未來 12 個月預估 EPS） */
  fwdPe: number;
  /** 本益比（近 12 個月） */
  pe: number | null;
  pbv: number | null;
  /** 殖利率（%） */
  dy: number | null;
  /** 1 個月、今年以來報酬（%，美元、含息） */
  ret1m: number | null;
  ytd: number | null;
  /** 全球（MSCI ACWI IMI）預估本益比 */
  acwiFwdPe: number | null;
}

export interface MsciTwFile {
  schemaVersion: 1;
  generatedAt: string;
  /** 依資料日遞增 */
  records: MsciRecord[];
  /** 年度報酬（%，美元、含息）：年份 → 報酬；各期 factsheet 的年度表合併 */
  annual: Record<string, number>;
}

/** 合併（同資料日以新的為準）；年度報酬以後來的檔為準 */
export function mergeMsci(
  existing: MsciTwFile | null,
  incoming: readonly (MsciRecord & { annual?: Record<string, number> })[],
  now: Date,
): MsciTwFile {
  const map = new Map<string, MsciRecord>();
  for (const r of existing?.records ?? []) map.set(r.asOf, r);
  const annual: Record<string, number> = { ...(existing?.annual ?? {}) };
  for (const r of [...incoming].sort((a, b) => (a.asOf < b.asOf ? -1 : 1))) {
    const { annual: a, ...rec } = r;
    map.set(rec.asOf, rec);
    Object.assign(annual, a ?? {});
  }
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    records: [...map.values()].sort((a, b) => (a.asOf < b.asOf ? -1 : 1)),
    annual,
  };
}

export interface FwdEpsPoint {
  asOf: string;
  fwdPe: number;
  /** 未來 12 月 EPS 預估（台幣計；每段第一筆＝100，接不起來時重新起算）；缺匯率或今年以來報酬時為 null */
  eps: number | null;
  /** 與上一筆相比（%）與相隔月數 */
  chg: number | null;
  months: number | null;
}

/**
 * 把各期 factsheet 接成「未來 12 月 EPS 預估」走勢（台幣計）：
 *   EPS ∝ 價格 ÷ 預估本益比 × 美元兌台幣
 * 價格用 factsheet 的美元含息報酬接：同一年用今年以來報酬，跨年再乘中間各年的年度報酬；
 * 含息報酬扣掉兩期平均殖利率 × 相隔年數，近似成價格報酬。缺年度報酬或匯率時斷開（chg＝null，之後重新起算）。
 */
export function fwdEpsPath(file: MsciTwFile, usdTwd: readonly Point[]): FwdEpsPoint[] {
  const fxAt = (d: string): number | null => {
    const p = valueAtOrBefore(usdTwd, d);
    return p && Date.parse(d) - Date.parse(p[0]) <= 7 * 86_400_000 ? p[1] : null;
  };
  const out: FwdEpsPoint[] = [];
  let prev: { r: MsciRecord; eps: number; fx: number } | null = null;
  for (const r of file.records) {
    const fx = fxAt(r.asOf);
    let eps: number | null = null;
    let chg: number | null = null;
    let months: number | null = null;
    const p = prev;
    if (fx !== null && r.ytd !== null) {
      const ratio: number | null = p ? grossRatio(p.r, r, file.annual) : null;
      if (p && ratio !== null) {
        const years: number = (Date.parse(r.asOf) - Date.parse(p.r.asOf)) / (365.25 * 86_400_000);
        const dy: number = ((p.r.dy ?? 0) + (r.dy ?? 0)) / 2;
        const price: number = ratio * Math.exp((-dy / 100) * years);
        const e: number = p.eps * price * (p.r.fwdPe / r.fwdPe) * (fx / p.fx);
        eps = e;
        chg = (e / p.eps - 1) * 100;
        months = monthsBetween(p.r.asOf, r.asOf);
      } else eps = 100; // 第一筆或接不起來：重新起算
    }
    out.push({ asOf: r.asOf, fwdPe: r.fwdPe, eps, chg, months });
    prev = eps !== null && fx !== null ? { r, eps, fx } : null;
  }
  return out;
}

/** 兩期之間美元含息報酬（倍數）；缺中間年份的年度報酬時回傳 null */
function grossRatio(a: MsciRecord, b: MsciRecord, annual: Record<string, number>): number | null {
  const ya = Number(a.asOf.slice(0, 4));
  const yb = Number(b.asOf.slice(0, 4));
  if (a.ytd === null || b.ytd === null || yb < ya) return null;
  let r = (1 + b.ytd / 100) / (1 + a.ytd / 100);
  for (let y = ya; y < yb; y++) {
    const v = annual[String(y)];
    if (v === undefined) return null;
    r *= 1 + v / 100;
  }
  return r;
}

function monthsBetween(a: string, b: string): number {
  const [ay, am] = monthKey(a).split('-').map(Number) as [number, number];
  const [by, bm] = monthKey(b).split('-').map(Number) as [number, number];
  return (by - ay) * 12 + (bm - am);
}

export interface MsciSummary {
  latest: MsciRecord;
  /** 近 12 月本益比 ÷ 預估本益比 − 1（%）：市場預期的未來 12 月 EPS 成長 */
  impliedGrowth: number | null;
  /** 對全球（ACWI IMI）溢價（%） */
  premium: number | null;
  /** 未來 12 月 EPS 預估與上一筆相比（%）、相隔月數、上一筆日期 */
  epsChg: number | null;
  epsMonths: number | null;
  prevAsOf: string | null;
  /** 預估 EPS 比上一筆少（下修；未來 12 月的窗格每月往後滾，持平其實就是下修） */
  cut: boolean;
  /** 收錄的月份數與預估本益比的最低、中位數、最高 */
  n: number;
  min: MsciRecord;
  max: MsciRecord;
  median: number;
  /** 最新一筆是否超過 2 個月沒更新（factsheet 格式改變或抓取失敗） */
  stale: boolean;
}

export function msciSummary(file: MsciTwFile | null, usdTwd: readonly Point[], today: string): MsciSummary | null {
  const recs = file?.records ?? [];
  const latest = recs.at(-1);
  if (!file || !latest) return null;
  const path = fwdEpsPath(file, usdTwd);
  const last = path.at(-1)!;
  const prevAsOf = recs.length > 1 ? recs.at(-2)!.asOf : null;
  let min = recs[0]!;
  let max = recs[0]!;
  for (const r of recs) {
    if (r.fwdPe < min.fwdPe) min = r;
    if (r.fwdPe > max.fwdPe) max = r;
  }
  return {
    latest,
    impliedGrowth: latest.pe ? (latest.pe / latest.fwdPe - 1) * 100 : null,
    premium: latest.acwiFwdPe ? (latest.fwdPe / latest.acwiFwdPe - 1) * 100 : null,
    epsChg: last.chg,
    epsMonths: last.months,
    prevAsOf,
    cut: last.chg !== null && last.chg <= 0,
    n: recs.length,
    min,
    max,
    median: median(recs.map((r) => r.fwdPe)) ?? latest.fwdPe,
    stale: monthKey(latest.asOf) < monthKey(addMonths(`${monthKey(today)}-01`, -2)),
  };
}
