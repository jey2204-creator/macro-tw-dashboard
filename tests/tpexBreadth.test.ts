import { describe, expect, it } from 'vitest';
import { parseTpexBreadth, pickBreadth, tpexQuotesUrl } from '../scripts/fetch-data/sources/tpexBreadth';

// 2026 新站欄位（含尾端空白）；2012 以前少「最後買量／最後賣量」兩欄，順序相同
const fields = ['代號', '名稱', '收盤 ', '漲跌', '開盤 ', '最高 ', '最低', '成交股數  ', ' 成交金額(元)', ' 成交筆數 ', '最後買價', '最後賣價', '發行股數 ', '次日漲停價 ', '次日跌停價'];
const row = (code: string, close: string, chg: string) => [code, '', close, chg, '', '', '', '', '', '', '', '', '', '', ''];
const quotes = (data: string[][]) => ({ stat: 'ok', date: '20260101', tables: [{ title: '上櫃股票每日收盤行情(不含定價)', fields, data }] });

describe('上櫃漲跌家數（櫃買中心每日收盤行情推算）', () => {
  it('網址用 YYYY/MM/DD（已編碼）', () => {
    expect(tpexQuotesUrl('2026-11-06')).toContain('date=2026%2F11%2F06');
    expect(tpexQuotesUrl('2026-11-06')).toContain('type=EW');
  });

  it('10% 時期：漲跌停由前日收盤推算，ETF／權證不算', () => {
    const b = parseTpexBreadth(
      quotes([
        row('3105', '110.00', '+10.00'), // 前日 100 → 漲停 110.0
        row('6488', '99.00', '+1.00'), // 上漲但未漲停
        row('4966', '90.00', '-10.00'), // 前日 100 → 跌停 90.0
        row('5347', '95.00', '-5.00'),
        row('8069', '50.00', '0.00'), // 平盤
        row('00679B', '32.20', '+0.92'), // ETF 不算
        row('03124P', '0.50', '-0.10'), // 權證不算
        row('912000', '10.00', '+1.00'), // 6 位數 TDR 不算
      ]),
      '2026-11-06',
    );
    expect(b).toEqual({ up: 2, upLimit: 1, down: 2, downLimit: 1, flat: 1, source: 'computed' });
    expect(pickBreadth('LIMIT_UP', b!)).toBe(1);
    expect(pickBreadth('DECLINE', b!)).toBe(2);
  });

  it('7% 時期（2015-06 前）：舊格式「- 1.50」帶空格、「+0.00」算平盤', () => {
    const b = parseTpexBreadth(
      quotes([
        row('1256', '93.00', '- 7.00'), // 前日 100 → 7% 跌停 93.0
        row('1258', '107.00', '+ 7.00'), // 前日 100 → 7% 漲停 107.0
        row('1259', '105.00', '+ 5.00'),
        row('1260', '20.00', '+0.00'),
        row('1261', '20.00', 'X'), // 除權息等無漲跌 → 平盤
      ]),
      '2012-01-04',
    );
    expect(b).toEqual({ up: 2, upLimit: 1, down: 1, downLimit: 1, flat: 2, source: 'computed' });
  });

  it('休市（0 筆）或 stat 非 ok 回傳 null', () => {
    expect(parseTpexBreadth(quotes([]), '2007-01-04')).toBeNull();
    expect(parseTpexBreadth({ stat: 'error', tables: [] }, '2026-01-01')).toBeNull();
  });

  it('欄位不符時丟出錯誤（避免整段回補成 0）', () => {
    expect(() => parseTpexBreadth({ stat: 'ok', tables: [{ fields: ['代號', '名稱', '收盤 '], data: [['1234', 'x', '10']] }] }, '2026-01-01')).toThrow(/欄位不符/);
  });
});
