import { describe, expect, it } from 'vitest';
import { computeBreadth, limitPctOn, parseBreadth, parseOfficialBreadth } from '../scripts/fetch-data/sources/twseChips';

const priceFields = ['證券代號', '證券名稱', '成交股數', '成交筆數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌(+/-)', '漲跌價差'];
const up = "<p style= color:red>+</p>";
const dn = "<p style= color:green>-</p>";
const row = (code: string, close: string, sign: string, diff: string) => [code, '', '', '', '', '', '', '', close, sign, diff];

describe('漲跌家數', () => {
  it('解析官方「漲跌證券數合計」股票欄', () => {
    const j = {
      stat: 'OK',
      tables: [
        {
          title: '漲跌證券數合計',
          fields: ['類型', '整體市場', '股票'],
          data: [
            ['上漲(漲停)', '11,001(204)', '741(26)'],
            ['下跌(跌停)', '4,637(73)', '240(2)'],
            ['持平', '985', '99'],
            ['未成交', '16,914', '3'],
          ],
        },
      ],
    };
    expect(parseOfficialBreadth(j)).toEqual({ up: 741, upLimit: 26, down: 240, downLimit: 2, flat: 99, source: 'official' });
  });

  it('無官方表時由逐檔推算；7% 時期與 10% 時期分開判斷', () => {
    expect(limitPctOn('2015-05-29')).toBe(0.07);
    expect(limitPctOn('2015-06-01')).toBe(0.1);
    const j = {
      stat: 'OK',
      tables: [
        {
          title: '每日收盤行情',
          fields: priceFields,
          data: [
            // 前日 100 → 7% 跌停 93.0
            row('1101', '93.00', dn, '7.00'),
            // 前日 100 → 跌 6.9，未跌停
            row('1102', '93.10', dn, '6.90'),
            // 前日 20 → 7% 漲停 21.40
            row('1103', '21.40', up, '1.40'),
            row('1104', '50.00', '<p> </p>', '0.00'),
            // ETF 不計
            row('0050', '100.00', dn, '7.00'),
          ],
        },
      ],
    };
    expect(computeBreadth(j, '2010-03-02')).toEqual({ up: 1, upLimit: 1, down: 2, downLimit: 1, flat: 1, source: 'computed' });
    // 同一份資料在 10% 時期：93 不是跌停
    expect(computeBreadth(j, '2020-03-19')!.downLimit).toBe(0);
    expect(parseBreadth(j, '2010-03-02')!.source).toBe('computed');
  });
});
