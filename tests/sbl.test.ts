import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpOptions } from '../scripts/fetch-data/http';
import { fetchTwseChips, parseTwt72u, parseTwt93u, resetTwseChipsCache, weekdaysBackward } from '../scripts/fetch-data/sources/twseChips';
import { combineSblRows, sblEvents, sblStateAt, sblUnsold, summarizeSbl, type SblRow } from '../src/shared/marginStress';
import type { Bar } from '../src/shared/types';

/** 證交所 TWT93U：欄名自帶前綴的寫法 */
const prefixed = {
  stat: 'OK',
  fields: ['股票代號', '股票名稱', '融券前日餘額', '融券賣出', '融券買進', '融券現券', '融券今日餘額', '融券限額',
    '借券賣出前日餘額', '借券賣出當日賣出', '借券賣出當日還券', '借券賣出當日調整', '借券賣出當日餘額', '借券賣出次一營業日可限額', '備註'],
  data: [
    ['0050', '元大台灣50', '1', '2', '3', '0', '4', '9', '100,000,000', '20,000,000', '5,000,000', '0', '115,000,000', '999', ''],
    ['2330', '台積電', '1', '2', '3', '0', '4', '9', '9,000,000,000', '435,000,000', '92,000,000', '0', '9,343,000,000', '999', ''],
    ['', '合計', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ],
};
/** groups 分組（只有 span）、欄名不帶前綴的寫法（證交所現行格式，2012 年中起） */
const grouped = {
  stat: 'OK',
  groups: [{ title: '股票', span: 2 }, { title: '融券', span: 6 }, { title: '借券賣出', span: 6 }, { title: '', span: 1 }],
  fields: ['股票代號', '股票名稱', '前日餘額', '賣出', '買進', '現券', '今日餘額', '限額', '前日餘額', '當日賣出', '當日還券', '當日調整', '當日餘額', '次一營業日可限額', '備註'],
  data: prefixed.data,
};

describe('借券賣出（TWT93U）', () => {
  beforeEach(() => resetTwseChipsCache());

  it('逐檔加總借券賣出當日餘額／賣出／還券，股→萬張', () => {
    const want = { balance: 945.8, sell: 45.5, ret: 9.7 };
    expect(parseTwt93u(prefixed)).toEqual(want);
    expect(parseTwt93u(grouped)).toEqual(want);
    expect(parseTwt93u({ stat: '很抱歉，沒有符合條件的資料!' })).toBeNull();
  });

  it('舊格式（2012 年上半以前）：沒有還券欄，還券＝前日＋賣出−今日', () => {
    const old = {
      stat: 'OK',
      groups: [{ title: '股票', span: 2 }, { title: '融券', span: 6 }, { title: '借券賣出', span: 5 }, { title: '', span: 1 }],
      fields: ['代號', '名稱', '前日餘額', '賣出', '買進', '現券', '今日餘額', '次一營業日限額', '前日餘額', '賣出', '庫存異動', '今日餘額', '可使用額度', '備註'],
      data: [
        ['2330', '台積電', '0', '0', '0', '0', '0', '9', '9,000,000,000', '435,000,000', '0', '9,343,000,000', '999,999,999', ''],
        ['2317', '鴻海', '0', '0', '0', '0', '0', '9', '100,000,000', '0', '0', '80,000,000', '999,999,999', ''],
      ],
    };
    // 台積電 還券＝9,000+435−9,343＝92（百萬股）；鴻海＝100+0−80＝20
    expect(parseTwt93u(old)).toEqual({ balance: 942.3, sell: 43.5, ret: 11.2 });
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

  it('單日逾時只略過該日，不停整段；快取缺洞會補抓', async () => {
    const urls: string[] = [];
    const http: HttpOptions = {
      retries: 0,
      fetchImpl: async (url) => {
        urls.push(url);
        if (url.includes('date=20261104')) throw new Error('This operation was aborted');
        return new Response(JSON.stringify(prefixed));
      },
    };
    // 快取 10/27～11/03，但缺 10/30（缺洞）
    const cached: Bar[] = weekdaysBackward('2026-11-03', '2026-10-27', 25)
      .reverse()
      .filter((d) => d !== '2026-10-30')
      .map((d) => [d, 1, 1, 1, 1]);
    const r = await fetchTwseChips('SBL_SELL_BAL', cached, '2026-11-06', http, true);
    const dates = r.bars.map((b) => b[0]);
    expect(dates).toContain('2026-11-06'); // 11/04 逾時後仍繼續
    expect(dates).not.toContain('2026-11-04');
    expect(dates).toContain('2026-10-30'); // 缺洞補抓
  });

  it('合併與摘要：餘額增減、近 5 日、連增日數、近 60 日新高', () => {
    const bal: Bar[] = [1600, 1610, 1605, 1620, 1650, 1700, 1760, 1823].map((v, i) => [`2026-11-0${i + 1}`, v, v, v, v]);
    const rows = combineSblRows({ balance: bal, sell: [['2026-11-08', 1, 1, 1, 45.5]], ret: [['2026-11-08', 1, 1, 1, 9.7]] });
    expect(rows.at(-1)).toEqual(['2026-11-08', 1823, 63, 45.5, 9.7, null, null, null, null, null, null]);
    expect(Number.isNaN(rows[0]![2])).toBe(true);
    const s = summarizeSbl(rows)!;
    expect(s).toMatchObject({ date: '2026-11-08', balance: 1823, chg5: 218, streak: 5, hi60: true, lo60: false });
    const falling: SblRow[] = [1800, 1790, 1780].map((v, i) => [`2026-11-1${i}`, v, NaN, NaN, NaN, null, null, null, null, null, null]);
    expect(summarizeSbl(falling)!.streak).toBe(-2);
    expect(summarizeSbl([])).toBeNull();
  });
  it('長期歷史與每日排程合併：同一天以每日排程為準、依日期排序', () => {
    const rows = combineSblRows(
      { balance: [['2026-11-05', 1, 1, 1, 1786.7], ['2026-11-06', 1, 1, 1, 1822.5]] },
      [['2026-11-03', 1723.3, 52.3, 23.4], ['2026-11-05', 1700, 1, 1]],
    );
    expect(rows.map((r) => [r[0], r[1]])).toEqual([['2026-11-03', 1723.3], ['2026-11-05', 1786.7], ['2026-11-06', 1822.5]]);
    expect(rows[1]![2]).toBe(63.4);
  });
  it('20 日變化率與 3 年分位帶：資料夠才算、追空／回補極端各自 20 日冷卻', () => {
    // 600 天：餘額每天 +0.1%（20 日變化約 +2%），第 580 天起每天 +2%（20 日變化衝到 +40% 以上）
    const bal: Bar[] = [];
    let v = 1000;
    for (let i = 0; i < 600; i++) {
      v *= i >= 580 ? 1.02 : 1.001;
      const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);
      bal.push([d, v, v, v, v]);
    }
    const rows = combineSblRows({ balance: bal });
    expect(rows[19]![5]).toBeNull(); // 不足 20 天
    expect(rows[20]![5]).toBeCloseTo(2.02, 1);
    expect(rows[519]![6]).toBeNull(); // 分位帶視窗不足 500 筆（第 20 天起才有變化率）
    expect(rows[520]![6]).not.toBeNull();
    expect(sblStateAt(rows[560]!)).toBe('normal');
    expect(sblStateAt(rows[599]!)).toBe('spike');
    const ev = sblEvents(rows);
    expect(ev.filter((e) => e.type === 'sblSpike')).toHaveLength(1); // 連續多天極端只標第一天
    expect(ev[0]!.date >= rows[580]![0]).toBe(true);
    const latest = summarizeSbl(rows)!;
    expect(latest.state).toBe('spike');
    expect(latest.pctAll).toBeGreaterThan(95);
  });
});

describe('借券餘額（TWT72U）與已借未賣', () => {
  const fields = ['股票代號', '股票名稱', '市場別', '前日借券餘額', '本日異動借券', '本日異動還券', '本日借券餘額', '次一營業日可借券賣出張數'];
  const twt72u = {
    stat: 'OK',
    tables: [
      {
        title: '有價證券借貸資訊',
        fields,
        data: [
          ['2330', '台積電', '集中市場', '100,000,000', '5,000,000', '1,000,000', '104,000,000', ''],
          ['0050', '元大台灣50', '集中市場', '20,000,000', '0', '2,000,000', '18,000,000', ''],
          ['00631L', '元大台灣50正2', '集中市場', '1,000,000', '0', '0', '1,000,000', ''],
          ['', '合計', '集中市場', '121,000,000', '5,000,000', '3,000,000', '123,000,000', ''],
          ['5483', '中美晶', '上櫃', '9,000,000', '1,000,000', '0', '10,000,000', ''],
          ['', '合計', '上櫃', '9,000,000', '1,000,000', '0', '10,000,000', ''],
        ],
      },
    ],
  };
  it('只加總集中市場的證券列、排除合計列與上櫃，股→萬張', () => {
    expect(parseTwt72u(twt72u)).toEqual({ balance: 12.3, lend: 0.5, ret: 0.3 });
  });
  it('查無資料 → null；欄位缺 → 擲錯', () => {
    expect(parseTwt72u({ stat: '很抱歉，沒有符合條件的資料!' })).toBeNull();
    expect(() => parseTwt72u({ stat: 'OK', fields: ['股票代號', '市場別'], data: [] })).toThrow(/欄位異常/);
  });
  it('合併借券餘額：對得上日期才填、已借未賣＝借券餘額 − 賣出餘額、近 5 日變化', () => {
    const bal: Bar[] = [1600, 1610, 1605, 1620, 1650, 1700, 1760, 1823].map((v, i) => [`2026-11-0${i + 1}`, v, v, v, v]);
    const lendBal: Bar[] = [2600, 2650, 2700, 2750, 2800, 2851.4, 2971.4].map((v, i) => [`2026-11-0${i + 2}`, v, v, v, v]);
    const rows = combineSblRows(
      { balance: bal, lendBal, lend: [['2026-11-08', 1, 1, 1, 176.35]], lendRet: [['2026-11-08', 1, 1, 1, 56.35]] },
      [],
      [['2026-11-01', 2500, 10, 5]],
    );
    expect(rows[0]!.slice(8)).toEqual([2500, 10, 5]); // 來自長期歷史
    expect(rows.at(-1)!.slice(8)).toEqual([2971.4, 176.35, 56.35]);
    expect(rows[1]!.slice(9)).toEqual([null, null]); // 當日借券/還券沒有資料 → null
    expect(sblUnsold(rows.at(-1)!)).toBe(1148.4);
    expect(sblUnsold([...rows[0]!.slice(0, 8), null, null, null] as SblRow)).toBeNull();
    const s = summarizeSbl(rows)!;
    // 11/03 已借未賣 2650−1605=1045 → 11/08 1148.4：+103.4
    expect(s).toMatchObject({ lendBal: 2971.4, unsold: 1148.4, unsoldChg5: 103.4 });
  });
});
