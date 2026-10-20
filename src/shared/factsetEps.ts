import { addDays } from './dates';

/**
 * FactSet Earnings Insight 週報的估值讀數（public/data/factset-eps.json）。
 * 每篇文章一筆；歷史只能從開始抓的那週往後累積（FactSet 不提供歷史序列）。
 */

export interface FactsetPost {
  /** 發布日（美東） */
  date: string;
  url: string;
  title: string;
  /** 預估本益比（未來 12 個月 EPS） */
  fwdPe: number;
  /** 預估本益比 5 年、10 年平均 */
  avg5: number | null;
  avg10: number | null;
  /** 年度 EPS 預估年增率（%），鍵＝年份，例 { "2026": 32.8, "2027": 15.1 } */
  cy: Record<string, number>;
  /** 未來季度 EPS 預估年增率（%），鍵例 "Q4 2026" */
  quarterEst: Record<string, number>;
  /** 財報季進行中的當季混合成長率（已公布＋預估） */
  blended: { quarter: string; growth: number } | null;
}

export interface FactsetEpsFile {
  schemaVersion: 1;
  generatedAt: string;
  /** 依日期遞增 */
  posts: FactsetPost[];
}

/** 合併（同網址以新的為準），依日期、網址排序 */
export function mergePosts(existing: readonly FactsetPost[], incoming: readonly FactsetPost[]): FactsetPost[] {
  const map = new Map<string, FactsetPost>();
  for (const p of existing) map.set(p.url, p);
  for (const p of incoming) map.set(p.url, p);
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.url < b.url ? -1 : 1));
}

export interface EpsRevision {
  year: string;
  /** 最新預估年增率（%） */
  now: number;
  /** weeks 週前（≤ 該日最後一篇）的預估 */
  before: number;
  beforeDate: string;
  /** 變化（pp） */
  change: number;
}

/**
 * 年度 EPS 預估的修正：最新一篇對 weeks 週前最後一篇，逐年比較。
 * 用來做「預估連續下修」警示：變化 ≤ −alertPp 視為下修。
 */
export function epsRevisions(posts: readonly FactsetPost[], weeks = 4): EpsRevision[] {
  const last = posts.at(-1);
  if (!last) return [];
  const cutoff = addDays(last.date, -7 * weeks);
  let ref: FactsetPost | null = null;
  for (const p of posts) if (p.date <= cutoff) ref = p;
  if (!ref) return [];
  const out: EpsRevision[] = [];
  for (const [year, now] of Object.entries(last.cy)) {
    const before = ref.cy[year];
    if (before === undefined) continue;
    out.push({ year, now, before, beforeDate: ref.date, change: now - before });
  }
  return out;
}

/** 下修門檻（pp）：年度預估 4 週內降超過這個數就標警示 */
export const EPS_REVISION_ALERT_PP = 1;

/** 下一個年度（最新文章提到的最大年份）；財報季更新通常同時給今年與明年 */
export function nextYearKey(post: FactsetPost): string | null {
  const years = Object.keys(post.cy).sort();
  return years.at(-1) ?? null;
}
