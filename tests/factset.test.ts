import { describe, expect, it } from 'vitest';
import {
  FACTSET_RSS,
  fetchFactsetForwardPe,
  htmlToText,
  parsePost,
  parseRss,
  parsedPosts,
} from '../scripts/fetch-data/sources/factset';
import type { Bar } from '../src/shared/types';

const POST_URL = 'https://insight.factset.com/sp-500-earnings-season-update-october-16-2026';
const OLD_URL = 'https://insight.factset.com/sp-500-earnings-season-preview-q3-2026';

/** 仿 HubSpot RSS：CDATA 標題、GMT 時間 */
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>FactSet Insight</title>
<item><title><![CDATA[Modeling Iron-Air Battery Arbitrage in U.S. Power Markets]]></title><link>https://insight.factset.com/iron-air</link><pubDate>Fri, 16 Oct 2026 21:45:00 GMT</pubDate></item>
<item><title><![CDATA[S&P 500 Earnings Season Update: October 16, 2026]]></title><link>${POST_URL}</link><pubDate>Fri, 16 Oct 2026 17:03:12 GMT</pubDate></item>
<item><title>S&amp;P 500 Earnings Season Preview: Q3 2026</title><link>${OLD_URL}</link><pubDate>Sat, 03 Oct 2026 02:30:00 GMT</pubDate></item>
</channel></rss>`;

/** 仿文章頁：句型取自 2026-10-16 週報 */
const POST_HTML = `<html><head><title>x</title><script>var a = "forward 12-month P/E ratio is 99";</script></head><body>
<div class="post-body"><p>Overall, 12% of the companies in the S&amp;P 500 have reported actual results for Q3 2026 to date.</p>
<p>As a result, the (blended) earnings growth rate for the third quarter is 29.0% today, compared to an earnings growth rate of 29.4% last week.</p>
<p>For Q4 2026, analysts are projecting (year-over-year) earnings growth of 20.1% and revenue growth of 7.5%.</p>
<p>For CY 2026, analysts are predicting (year-over-year) earnings growth of 32.8% and revenue growth of 8.9%. For CY 2027, analysts are predicting (year-over-year) earnings growth of 15.1% and revenue growth of 7.2%.</p>
<p>The forward 12-month P/E ratio is 19.0, which is below the 5-year average (19.8) and below the 10-year average (19.1).</p></div></body></html>`;

const META = { title: 'S&P 500 Earnings Season Update: October 16, 2026', link: POST_URL, date: '2026-10-16' };

describe('FactSet 週報解析', () => {
  it('RSS：CDATA 與實體還原，GMT 時間換成美東日期（10/3 02:30 GMT ＝ 10/2 美東）', () => {
    const items = parseRss(RSS);
    expect(items.map((i) => [i.title, i.date])).toEqual([
      ['Modeling Iron-Air Battery Arbitrage in U.S. Power Markets', '2026-10-16'],
      ['S&P 500 Earnings Season Update: October 16, 2026', '2026-10-16'],
      ['S&P 500 Earnings Season Preview: Q3 2026', '2026-10-02'],
    ]);
    expect(items[1]!.link).toBe(POST_URL);
  });

  it('文章：預估本益比、5／10 年均、年度與季度預估、混合成長；script 內的數字不算', () => {
    const post = parsePost(POST_HTML, META)!;
    expect(post.fwdPe).toBe(19.0);
    expect(post.avg5).toBe(19.8);
    expect(post.avg10).toBe(19.1);
    expect(post.cy).toEqual({ '2026': 32.8, '2027': 15.1 });
    expect(post.quarterEst).toEqual({ 'Q4 2026': 20.1 });
    expect(post.blended).toEqual({ quarter: 'Q3 2026', growth: 29.0 });
    expect(post.date).toBe('2026-10-16');
    // 沒有估值句子的文章 → null
    expect(parsePost('<p>Nothing here</p>', META)).toBeNull();
    expect(htmlToText('<p>a&nbsp;b</p> <b>c</b>')).toBe('a b c');
  });

  it('抓取：只抓比快取新的 S&P 500 文章、合併快取；沒有新文章時回傳快取原樣', async () => {
    parsedPosts.clear();
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (url === FACTSET_RSS) return new Response(RSS, { status: 200 });
      if (url === POST_URL) return new Response(POST_HTML, { status: 200 });
      if (url === OLD_URL) return new Response('<p>The forward 12-month P/E ratio is 19.5, which is below the 5-year average (19.8).</p>', { status: 200 });
      return new Response('nope', { status: 404 });
    };
    const http = { fetchImpl, retries: 0, retryDelayMs: 0 };
    // 無快取：兩篇 S&P 500 文章都抓，鐵空氣電池那篇不抓
    const first = await fetchFactsetForwardPe(null, http);
    expect(first.bars).toEqual([
      ['2026-10-02', 19.5, 19.5, 19.5, 19.5],
      ['2026-10-16', 19, 19, 19, 19],
    ]);
    expect(first.incremental).toBe(true);
    expect(calls).toEqual([FACTSET_RSS, OLD_URL, POST_URL]);
    expect(parsedPosts.get(POST_URL)?.cy['2027']).toBe(15.1);
    // 有快取到 10/09：只抓 10/16 那篇，並與快取合併
    calls.length = 0;
    parsedPosts.clear();
    const cached: Bar[] = [['2026-10-02', 19.5, 19.5, 19.5, 19.5], ['2026-10-09', 19.2, 19.2, 19.2, 19.2]];
    const second = await fetchFactsetForwardPe(cached, http);
    expect(second.bars.map((b) => [b[0], b[4]])).toEqual([['2026-10-02', 19.5], ['2026-10-09', 19.2], ['2026-10-16', 19]]);
    expect(calls).toEqual([FACTSET_RSS, POST_URL]);
    // 快取已到 10/16：沒有新文章，只打 RSS，回傳快取原樣
    calls.length = 0;
    const third = await fetchFactsetForwardPe(second.bars, http);
    expect(third.bars).toEqual(second.bars);
    expect(calls).toEqual([FACTSET_RSS]);
  });
});
