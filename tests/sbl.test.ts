import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpOptions } from '../scripts/fetch-data/http';
import { fetchTwseChips, parseTwt93u, resetTwseChipsCache, weekdaysBackward } from '../scripts/fetch-data/sources/twseChips';
import { combineSblRows, summarizeSbl, type SblRow } from '../src/shared/marginStress';
import type { Bar } from '../src/shared/types';

/** 證交所 TWT93U：欄名自帶前綴的寫法 */
const prefixed = {
  stat: 'OK',
  fields: ['股票代號', '股票名稱', '融券前日餘額', '融券賣出', '融券買進', '融券現券', '融券今日餘額', '融券限額',
    '借券賣出前日餘額', '借券賣出當日賣出', '借券賣出當日還券', '借券賣出當日調整', '借券賣出當日餘額', '借券賣出次一營業日可限額', '備註'],
  data: [
    ['0050', '元大台灣50', '1', '2', '3', '0', '4', '9', '100,000', '20,000', '5,000', '0', '115,000', '999', ''],
    ['2330', '台積電', '1', '2', '3', '0', '4', '9', '9,000,000', '435,000', '92,000', '0', '9,343,000', '999', ''],
    ['', '合計', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ],
};
/** groups 分組、欄名不帶前綴的寫法 */
const grouped = {
  stat: 'OK',
  groups: [{ start: 2, span: 6, title: '融券' }, { start: 8, span: 6, title: '借券賣出' }],
  fields: ['股票代號', '股票名稱', '前日餘額', '賣出', '買進', '現券', '今日餘額', '限額', '前日餘額', '當日賣出', '當日還券', '當日調整', '當日餘額', '次一營業日可限額', '備註'],
  data: prefixed.data,
};

describe('借券賣出（TWT93U）', () => {
  beforeEach(() => resetTwseChipsCache());

  it('逐檔加總借券賣出當日餘額／賣出／還券，張→萬張', () => {
    const want = { balance: 945.8, sell: 45.5, ret: 9.7 };
    expect(parseTwt93u(prefixed)).toEqual(want);
    expect(parseTwt93u(grouped)).toEqual(want);
    expect(parseTwt93u({ stat: '很抱歉，沒有符合條件的資料!' })).toBeNull();
  });

  it('欄位改名時擲錯並附上欄名', () => {
    expect(() => parseTwt93u({ stat: 'OK', fields: ['股票代號', '名稱', '其他'], data: [['2330', 'x', '1']] })).toThrow(/TWT93U 欄位異常/);
  });

  it('同一天的三個借券指標共用一次請求', async () => {
    const urls: string[] = [];
    const http: HttpOptions = {
      retries: 0,
      fetchImpl: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify(prefixed));
      },
    };
    const cached: Bar[] = weekdaysBackward('2026-11-05', '2000-01-01', 25).reverse().map((d) => [d, 1, 1, 1, 1]);
    const a = await fetchTwseChips('SBL_SELL_BAL', cached, '2026-11-06', http, true);
    const b = await fetchTwseChips('SBL_SELL', cached, '2026-11-06', http, true);
    const c = await fetchTwseChips('SBL_RETURN', cached, '2026-11-06', http, true);
    expect(a.bars.at(-1)![4]).toBe(945.8);
    expect(b.bars.at(-1)![4]).toBe(45.5);
    expect(c.bars.at(-1)![4]).toBe(9.7);
    expect(urls.every((u) => u.includes('TWT93U'))).toBe(true);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('合併與摘要：餘額增減、近 5 日、連增日數、近 60 日新高', () => {
    const bal: Bar[] = [1600, 1610, 1605, 1620, 1650, 1700, 1760, 1823].map((v, i) => [`2026-11-0${i + 1}`, v, v, v, v]);
    const rows = combineSblRows({ balance: bal, sell: [['2026-11-08', 1, 1, 1, 45.5]], ret: [['2026-11-08', 1, 1, 1, 9.7]] });
    expect(rows.at(-1)).toEqual(['2026-11-08', 1823, 63, 45.5, 9.7]);
    expect(Number.isNaN(rows[0]![2])).toBe(true);
    const s = summarizeSbl(rows)!;
    expect(s).toMatchObject({ date: '2026-11-08', balance: 1823, chg5: 218, streak: 5, hi60: true, lo60: false });
    const falling: SblRow[] = [1800, 1790, 1780].map((v, i) => [`2026-11-1${i}`, v, NaN, NaN, NaN]);
    expect(summarizeSbl(falling)!.streak).toBe(-2);
    expect(summarizeSbl([])).toBeNull();
  });
});
