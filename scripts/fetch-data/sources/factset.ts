import { toLocalDate } from '../../../src/shared/dates';
import type { FactsetPost } from '../../../src/shared/factsetEps';
import type { Bar } from '../../../src/shared/types';
import { getText, type HttpOptions } from '../http';
import type { SourceFetchResult } from './types';

/**
 * FactSet Insight 部落格（HubSpot）：John Butters 每週五的「S&P 500 Earnings Season Update／Earnings Insight」
 * 文章固定寫出「The forward 12-month P/E ratio is 19.0, which is below the 5-year average (19.8) and below the
 * 10-year average (19.1).」與「For CY 2026, analysts are predicting (year-over-year) earnings growth of 32.8%.」
 * 這是目前唯一免費、每週更新、且 GitHub 主機抓得到的 S&P 500 預估本益比來源
 * （S&P 官方的 sp-500-eps-est.xlsx 對 GitHub 主機回 403「Security Controls Triggered」，2026-10 探測）。
 *
 * 流程：RSS（只有摘要）→ 找標題含 S&P 500、比快取最後日期新的文章 → 逐篇抓全文 → 正規表達式取數字。
 * 歷史無法回補（只能從現在起每週累積一筆）；日期取文章發布日（美東）。
 * 同一個程序內解析過的文章放在 parsedPosts，給 writeFactsetEps.ts 寫出含 5／10 年均值與盈餘預估的 JSON，不必再抓一次。
 */

export const FACTSET_RSS = 'https://insight.factset.com/rss.xml';
/** 一次最多抓幾篇新文章（RSS 約 20 篇、每週約 5 篇） */
const MAX_POSTS = 8;

/** 本程序內已解析的文章（url → 內容） */
export const parsedPosts = new Map<string, FactsetPost>();

export interface RssItem {
  title: string;
  link: string;
  /** 發布日（美東日期 YYYY-MM-DD） */
  date: string;
}

const unescapeXml = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();

export function parseRss(xml: string): RssItem[] {
  const out: RssItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1]!;
    const pick = (tag: string) => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(item);
      return r ? unescapeXml(r[1]!) : '';
    };
    const title = pick('title');
    const link = pick('link');
    const pub = Date.parse(pick('pubDate'));
    if (!title || !link || !Number.isFinite(pub)) continue;
    out.push({ title, link, date: toLocalDate(pub / 1000, 'America/New_York') });
  }
  return out;
}

/** 去標籤、去實體、壓縮空白 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&[#\w]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const num = (s: string | undefined) => (s === undefined ? null : Number(s));

/**
 * 從文章全文取數字。找不到預估本益比就回傳 null（該篇不是估值週報）。
 * 句型（多年不變）：
 *  - The forward 12-month P/E ratio is 19.0, which is below the 5-year average (19.8) and below the 10-year average (19.1).
 *  - For CY 2026, analysts are predicting (year-over-year) earnings growth of 32.8% and revenue growth of 8.9%.
 *  - For Q4 2026, analysts are projecting (year-over-year) earnings growth of 20.1% and revenue growth of 7.5%.
 *  - ...the (blended) earnings growth rate for the third quarter is 29.0% today
 */
export function parsePost(html: string, meta: Pick<RssItem, 'title' | 'link' | 'date'>): FactsetPost | null {
  const text = htmlToText(html);
  const pe = /forward 12-month P\/E ratio(?: for the S&P 500)? is (\d+(?:\.\d+)?)/i.exec(text);
  if (!pe) return null;
  const cy: Record<string, number> = {};
  for (const m of text.matchAll(/For CY (20\d\d), analysts (?:are predicting|are projecting|expect) \(year-over-year\) earnings growth of (-?\d+(?:\.\d+)?)%/gi)) {
    cy[m[1]!] = Number(m[2]);
  }
  const quarterEst: Record<string, number> = {};
  for (const m of text.matchAll(/For (Q[1-4] 20\d\d), analysts (?:are predicting|are projecting|expect) \(year-over-year\) earnings growth of (-?\d+(?:\.\d+)?)%/gi)) {
    quarterEst[m[1]!] = Number(m[2]);
  }
  const blendedM = /earnings growth rate for the (first|second|third|fourth) quarter is (-?\d+(?:\.\d+)?)%/i.exec(text);
  const qWord: Record<string, string> = { first: 'Q1', second: 'Q2', third: 'Q3', fourth: 'Q4' };
  // 財報季更新文章的季度年份：標題或內文通常有「Q3 2026」；沒有就以發布日所在年度
  const qYear = /\bQ[1-4] (20\d\d)\b/.exec(`${meta.title} ${text.slice(0, 2000)}`)?.[1] ?? meta.date.slice(0, 4);
  return {
    date: meta.date,
    url: meta.link,
    title: meta.title,
    fwdPe: Number(pe[1]),
    avg5: num(/5-year average \((\d+(?:\.\d+)?)\)/i.exec(text)?.[1]),
    avg10: num(/10-year average \((\d+(?:\.\d+)?)\)/i.exec(text)?.[1]),
    cy,
    quarterEst,
    blended: blendedM ? { quarter: `${qWord[blendedM[1]!.toLowerCase()]} ${qYear}`, growth: Number(blendedM[2]) } : null,
  };
}

/** 可能含估值段落的文章：標題有 S&P 500 */
export const isCandidate = (item: RssItem) => /S&P 500/i.test(item.title);

/**
 * 預估本益比週資料：每篇文章一筆 [發布日, 預估本益比]。只抓比快取最後日期新的文章；
 * 沒有新文章時回傳快取原樣（status 維持 ok，不算失敗）。
 */
export async function fetchFactsetForwardPe(cached: readonly Bar[] | null, http: HttpOptions): Promise<SourceFetchResult> {
  const lastDate = cached?.at(-1)?.[0] ?? null;
  const items = parseRss(await getText(FACTSET_RSS, http, { headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } }));
  if (items.length === 0) throw new Error('RSS 沒有文章（格式可能改變）');
  const fresh = items
    .filter(isCandidate)
    .filter((it) => !lastDate || it.date > lastDate)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(-MAX_POSTS);
  const byDate = new Map<string, Bar>();
  for (const b of cached ?? []) byDate.set(b[0], b);
  for (const it of fresh) {
    let post = parsedPosts.get(it.link);
    if (!post) {
      const html = await getText(it.link, http, { headers: { Accept: 'text/html' } });
      const parsed = parsePost(html, it);
      if (!parsed) continue;
      parsedPosts.set(it.link, parsed);
      post = parsed;
    }
    // 同一天多篇以較晚處理（RSS 日期相同時以後者）為準
    byDate.set(post.date, [post.date, post.fwdPe, post.fwdPe, post.fwdPe, post.fwdPe]);
  }
  const bars = [...byDate.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (bars.length === 0) throw new Error(`最近 ${items.length} 篇文章沒有預估本益比句子`);
  return { bars, closeOnly: true, partial: false, incremental: true };
}
