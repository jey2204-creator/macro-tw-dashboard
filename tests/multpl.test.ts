import { describe, expect, it } from 'vitest';
import { multplUrl, parseMultplDate, parseMultplTable, parseMultplValue } from '../scripts/fetch-data/sources/multpl';

/** 仿 multpl.com 的月表：最上面一列「今天」（估計值），之後每月 1 日一列 */
function page(rows: [string, string][]): string {
  const body = rows.map(([d, v]) => `<tr><td class="left">${d}</td><td class="right">${v}</td></tr>`).join('\n');
  return `<html><body><table id="datatable"><thead><tr><th>Date</th><th>Value</th></tr></thead><tbody>${body}</tbody></table></body></html>`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 由新到舊產生 n 個月的列 */
function monthly(n: number, endYear: number, endMonth: number, f: (i: number) => string): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < n; i++) {
    const k = endYear * 12 + (endMonth - 1) - i;
    out.push([`${MONTHS[k % 12]} 1, ${Math.floor(k / 12)}`, f(i)]);
  }
  return out;
}

describe('multpl 月表解析', () => {
  it('日期與數值：估計值標記、千分位、含數字的 HTML 實體都不會干擾', () => {
    expect(parseMultplDate('Oct 16, 2026')).toBe('2026-10-16');
    expect(parseMultplDate('Jan 1, 1871')).toBe('1871-01-01');
    expect(parseMultplDate('Date')).toBeNull();
    expect(parseMultplValue('† (Estimate) 26.12')).toBe(26.12);
    expect(parseMultplValue('7,715.79')).toBe(7715.79);
    expect(parseMultplValue('(Estimate)')).toBeNull();
  });

  it('同一個月只留日期最晚的一列（今天的估計值取代當月月均值），其餘依日期遞增', () => {
    const rows: [string, string][] = [
      ['Oct 16, 2026', '<sup>&dagger;</sup> <span class="estimate">(Estimate)</span> 26.12'],
      ['Oct 1, 2026', '&#8224; (Estimate) 26.29'],
      ['Sep 1, 2026', '25.96'],
      ...monthly(118, 2026, 8, (i) => (20 + (i % 7)).toFixed(2)),
    ];
    const bars = parseMultplTable(page(rows));
    expect(bars.length).toBe(120);
    expect(bars.at(-1)).toEqual(['2026-10-16', 26.12, 26.12, 26.12, 26.12]);
    expect(bars.at(-2)).toEqual(['2026-09-01', 25.96, 25.96, 25.96, 25.96]);
    expect(bars[0]![0]).toBe('2016-11-01');
    for (let i = 1; i < bars.length; i++) expect(bars[i]![0] > bars[i - 1]![0]).toBe(true);
  });

  it('價格表千分位正常解析', () => {
    const rows: [string, string][] = [['Oct 16, 2026', '7,715.79'], ...monthly(110, 2026, 10, (i) => (7000 - i * 10).toLocaleString('en-US'))];
    const bars = parseMultplTable(page(rows));
    expect(bars.at(-1)![4]).toBe(7715.79);
    expect(bars.at(-2)![4]).toBe(6990);
  });

  it('列數太少（頁面格式改變）會丟出錯誤', () => {
    expect(() => parseMultplTable(page(monthly(20, 2026, 10, () => '20')))).toThrow(/只得到 20 列/);
    expect(() => parseMultplTable('<html><body>Access denied</body></html>')).toThrow();
  });

  it('網址', () => {
    expect(multplUrl('SP500_PE')).toBe('https://www.multpl.com/s-p-500-pe-ratio/table/by-month');
    expect(multplUrl('SHILLER_PE')).toBe('https://www.multpl.com/shiller-pe/table/by-month');
  });
});
