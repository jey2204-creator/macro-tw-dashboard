import { describe, expect, it } from 'vitest';
import {
  alignToTwCalendar,
  COMPARE_PRESETS,
  COMPARE_SERIES,
  correlationSeries,
  DEFAULT_COMPARE,
  MAX_COMPARE,
  nextWeekday,
  pairedReturns,
  pearson,
  rollingCorrelation,
  toggleCompare,
} from '../src/shared/crossMarket';
import { INDICATOR_MAP } from '../src/shared/indicators';
import type { Bar } from '../src/shared/types';

const bar = (d: string, o: number, h: number, l: number, c: number): Bar => [d, o, h, l, c];
const flat = (d: string, c: number): Bar => [d, c, c, c, c];

describe('跨市場對照：美系序列對齊台股交易日', () => {
  // 2026-10-05（一）～10-09（五）；台股 10-08（四）休市
  const tw = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-09', '2026-10-12'];

  it('平日：日期 d 的 K 棒移到 d+1（台股開盤時看到的那根）', () => {
    const us = [bar('2026-10-05', 1, 2, 0.5, 1.5), bar('2026-10-06', 1.5, 3, 1, 2)];
    expect(alignToTwCalendar(us, tw)).toEqual([bar('2026-10-06', 1, 2, 0.5, 1.5), bar('2026-10-07', 1.5, 3, 1, 2)]);
  });

  it('週五的美股 → 下週一；台股休市日（10-08）的美股與 10-07 合併到 10-09', () => {
    const us = [bar('2026-10-07', 10, 12, 9, 11), bar('2026-10-08', 11, 15, 10, 14), bar('2026-10-09', 14, 16, 13, 15)];
    expect(alignToTwCalendar(us, tw)).toEqual([
      bar('2026-10-09', 10, 15, 9, 14), // 10-07 與 10-08 合併：開取第一根、高低取極值、收取最後一根
      bar('2026-10-12', 14, 16, 13, 15),
    ]);
  });

  it('超出已知台股日期時放到下一個平日（等台股資料到齊後會自動併入實際交易日）', () => {
    const us = [bar('2026-10-16', 1, 1, 1, 1), bar('2026-10-19', 2, 2, 2, 2)];
    expect(alignToTwCalendar(us, tw).map((b) => b[0])).toEqual(['2026-10-19', '2026-10-20']);
    expect(nextWeekday('2026-10-17')).toBe('2026-10-19');
    expect(nextWeekday('2026-10-21')).toBe('2026-10-21');
  });

  it('空序列安全', () => {
    expect(alignToTwCalendar([], tw)).toEqual([]);
    expect(alignToTwCalendar([bar('2026-10-05', 1, 1, 1, 1)], [])).toEqual([bar('2026-10-06', 1, 1, 1, 1)]);
  });
});

describe('跨市場對照：報酬配對與滾動相關', () => {
  it('同向序列相關 1、反向 −1、無變異為 null', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 10);
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBeNull();
    expect(pearson([1, 2], [1, 2])).toBeNull();
  });

  it('滾動相關只在資料滿 n 筆後有值', () => {
    const r = rollingCorrelation([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], 3);
    expect(r.slice(0, 2)).toEqual([null, null]);
    expect(r[2]).toBeCloseTo(1, 10);
    expect(r[4]).toBeCloseTo(1, 10);
  });

  it('對照序列投影到台股交易日：沒有新 K 棒的日子不湊數，兩邊報酬期間相同', () => {
    const tw = [flat('2026-10-05', 100), flat('2026-10-06', 101), flat('2026-10-07', 103), flat('2026-10-09', 102)];
    // 對照序列 10-06 沒有資料（例如對齊後的美國假日），10-09 有
    const cmp = [flat('2026-10-05', 50), flat('2026-10-07', 52), flat('2026-10-09', 51)];
    const p = pairedReturns(tw, cmp);
    expect(p.dates).toEqual(tw.map((b) => b[0]));
    expect(p.tw[0]).toBeNull();
    expect(p.tw[1]).toBeNull(); // 10-06 對照序列無新 K 棒：不配對
    expect(p.cmp[1]).toBeNull();
    expect(p.tw[2]).toBeCloseTo(Math.log(103 / 100), 12); // 兩邊都從上一個配對點（10-05）起算
    expect(p.cmp[2]).toBeCloseTo(Math.log(52 / 50), 12);
    expect(p.tw[3]).toBeCloseTo(Math.log(102 / 103), 12);
    expect(p.cmp[3]).toBeCloseTo(Math.log(51 / 52), 12);
  });

  it('對照序列比台股晚開始時，開始前不配對', () => {
    const tw = [flat('2026-10-05', 100), flat('2026-10-06', 101), flat('2026-10-07', 103)];
    const cmp = [flat('2026-10-06', 50), flat('2026-10-07', 52)];
    const p = pairedReturns(tw, cmp);
    expect(p.tw.slice(0, 2)).toEqual([null, null]);
    expect(p.tw[2]).toBeCloseTo(Math.log(103 / 101), 12);
    expect(p.cmp[2]).toBeCloseTo(Math.log(52 / 50), 12);
  });

  it('ρ 以最近 n 組有效配對計算，沒有新配對的日子沿用前值', () => {
    const dates = Array.from({ length: 30 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
    const tw = dates.map((d, i) => flat(d, 100 + Math.sin(i) * 5));
    // 對照序列完全同向（倍數關係），但第 10 天沒有資料
    const cmp = dates.flatMap((d, i) => (i === 10 ? [] : [flat(d, 200 + Math.sin(i) * 10)]));
    const c = correlationSeries(pairedReturns(tw, cmp));
    expect(c[20].slice(0, 20).every((v) => v === null)).toBe(true);
    expect(c[20][21]).not.toBeNull(); // 第 22 天起累積滿 20 組（第 10 天缺一組）
    expect(c[20][29]).toBeCloseTo(1, 6);
    expect(c[60].every((v) => v === null)).toBe(true);
  });
});

describe('跨市場對照：可選序列', () => {
  it('每個對照 id 都在指標註冊表內，櫃買排第一，預設三個分別來自不同資訊來源', () => {
    for (const s of COMPARE_SERIES) expect(INDICATOR_MAP[s.id], s.id).toBeDefined();
    expect(COMPARE_SERIES[0]!.id).toBe('tpex');
    expect(DEFAULT_COMPARE).toEqual(['sox', 'kospi', 'usdtwd']);
    const sessions = DEFAULT_COMPARE.map((id) => COMPARE_SERIES.find((s) => s.id === id)!.session);
    expect(sessions).toEqual(['us', 'tw', 'tw']);
  });

  it('組合內的 id 都可選且不超過上限', () => {
    const ids = COMPARE_SERIES.map((s) => s.id);
    for (const g of COMPARE_PRESETS) {
      expect(g.ids.length).toBeLessThanOrEqual(MAX_COMPARE);
      for (const id of g.ids) expect(ids, `${g.label}:${id}`).toContain(id);
    }
    expect(COMPARE_PRESETS.map((g) => g.label)).toEqual(['股市', '匯率利率', '亞洲資金', '避險']);
    expect(COMPARE_SERIES.map((s) => s.id)).toContain('gold');
    expect(COMPARE_SERIES.map((s) => s.id)).toContain('vix');
  });

  it('TLT 緊接在美債10Y 之後（窗格順序），前一晚時段，列入匯率利率組合，隱藏且不計分', () => {
    const ids = COMPARE_SERIES.map((s) => s.id);
    expect(ids[ids.indexOf('us10y') + 1]).toBe('tlt');
    expect(COMPARE_SERIES.find((s) => s.id === 'tlt')!.session).toBe('us');
    expect(COMPARE_PRESETS.find((g) => g.key === 'rates')!.ids).toEqual(['usdtwd', 'dxy', 'us10y', 'tlt', 'us2y']);
    expect(INDICATOR_MAP.tlt!.hidden).toBe(true);
    expect(INDICATOR_MAP.tlt!.weight).toBe(0);
  });

  it('USD/KRW、USD/JPY 緊接在 USD/TWD 之後、與台股同時段；亞洲資金組合＝亞股＋三個亞洲貨幣＋DXY；隱藏且不計分', () => {
    const ids = COMPARE_SERIES.map((s) => s.id);
    const i = ids.indexOf('usdtwd');
    expect(ids.slice(i, i + 3)).toEqual(['usdtwd', 'usdkrw', 'usdjpy']);
    for (const id of ['usdkrw', 'usdjpy']) {
      expect(COMPARE_SERIES.find((s) => s.id === id)!.session).toBe('tw');
      expect(INDICATOR_MAP[id]!.hidden).toBe(true);
      expect(INDICATOR_MAP[id]!.weight).toBe(0);
      expect(INDICATOR_MAP[id]!.category).toBe('fx');
    }
    expect(INDICATOR_MAP.usdkrw!.sources[0]!.symbol).toBe('KRW=X');
    expect(INDICATOR_MAP.usdjpy!.sources[0]!.symbol).toBe('JPY=X');
    expect(COMPARE_PRESETS.find((g) => g.key === 'asia')!.ids).toEqual(['kospi', 'usdtwd', 'usdkrw', 'usdjpy', 'dxy']);
  });

  it('已滿 5 個時再選會換掉最早選的；已選的點一下取消', () => {
    const five = ['usdtwd', 'dxy', 'us10y', 'us2y', 'wti'];
    expect(toggleCompare(five, 'sox')).toEqual(['dxy', 'us10y', 'us2y', 'wti', 'sox']);
    expect(toggleCompare(five, 'dxy')).toEqual(['usdtwd', 'us10y', 'us2y', 'wti']);
    expect(toggleCompare(['sox'], 'tpex')).toEqual(['sox', 'tpex']);
    expect(toggleCompare([], 'tpex')).toEqual(['tpex']);
  });
});
