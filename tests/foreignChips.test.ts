import { describe, expect, it } from 'vitest';
import {
  analyzeForeignChips,
  combineForeignRows,
  detectForeignEvents,
  rollingPctl,
  type ForeignRow,
} from '../src/shared/foreignChips';
import type { Bar } from '../src/shared/types';

const day = (i: number) => {
  const d = new Date(Date.UTC(2024, 0, 1 + i));
  return d.toISOString().slice(0, 10);
};
const flat = (d: string, v: number): Bar => [d, v, v, v, v];

describe('外資籌碼對照：合併', () => {
  it('只保留至少有一項籌碼的台股交易日；累計需視窗內每天都有買賣超', () => {
    const taiex = Array.from({ length: 30 }, (_, i) => flat(day(i), 100 + i));
    // 期貨從第 0 天、買賣超從第 10 天起
    const foreignOi = taiex.map((b, i) => flat(b[0], -1000 - i));
    const net = taiex.slice(10).map((b) => flat(b[0], 1));
    const rows = combineForeignRows({ net, foreignOi }, [flat('2023-12-31', 99), ...taiex]);
    expect(rows).toHaveLength(30);
    expect(rows[0]![2]).toBeNull();
    expect(rows[0]![5]).toBe(-1000);
    expect(rows[0]![6]).toBeNull(); // 第一天沒有前值
    expect(rows[1]![6]).toBe(-1);
    // 第 10 天起才有買賣超；5 日累計要到第 14 天、20 日累計要到第 29 天
    expect(rows[13]![3]).toBeNull();
    expect(rows[14]![3]).toBe(5);
    expect(rows[28]![4]).toBeNull();
    expect(rows[29]![4]).toBe(20);
    // 散戶欄缺資料為 null
    expect(rows[29]![7]).toBeNull();
  });
});

describe('外資籌碼對照：百分位與事件', () => {
  it('rollingPctl：資料不足回 null，極值為 0／1 附近', () => {
    const v = Array.from({ length: 10 }, (_, i) => i);
    expect(rollingPctl(v, 10, 10).slice(0, 9).every((x) => x === null)).toBe(true);
    expect(rollingPctl(v, 10, 10)[9]).toBe(0.95); // 9 低於、1 等於 → (9 + 0.5) / 10
    expect(rollingPctl([5, null, 1], 3, 2)[2]).toBe(0.25);
  });

  it('事件只在首次進入極端時標一次，回到中位數另一側才可再標；賣超不跌需加權 20 日不跌', () => {
    // 130 天：外資期 OI 大多在 -1000 附近，第 125 天跌到 -9000（空單極端），126 回來，128 再跌
    const rows: ForeignRow[] = Array.from({ length: 130 }, (_, i) => [day(i), 100, 0, 0, 0, -1000 + (i % 7), null, 0, null]);
    rows[125]![5] = -9000;
    rows[126]![5] = -996; // 回到中位數以上 → 重新武裝
    rows[127]![5] = -996;
    rows[128]![5] = -9500;
    const pctl = { cum20: rollingPctl(rows.map((r) => r[4])), foreignOi: rollingPctl(rows.map((r) => r[5])), retailOi: rollingPctl(rows.map((r) => r[7])) };
    const ev = detectForeignEvents(rows, pctl).filter((e) => e.type === 'oi_short');
    expect(ev.map((e) => e.date)).toEqual([day(125), day(128)]);
    expect(ev[0]!.value).toBe(-9000);

    // 20 日累計賣超極端但加權不跌 → 賣超不跌＋累計賣超極端同日
    const rows2: ForeignRow[] = Array.from({ length: 130 }, (_, i) => [day(i), 100 + i * 0.1, 0, 0, (i % 3), -1000, null, 0, null]);
    rows2[125]![4] = -500;
    const pctl2 = { cum20: rollingPctl(rows2.map((r) => r[4])), foreignOi: rollingPctl(rows2.map((r) => r[5])), retailOi: rollingPctl(rows2.map((r) => r[7])) };
    const ev2 = detectForeignEvents(rows2, pctl2);
    expect(ev2.map((e) => e.type).sort()).toEqual(['sell_extreme', 'sell_no_fall']);
    // 加權 20 日下跌時只有累計賣超極端，沒有賣超不跌
    const rows3 = rows2.map((r, i): ForeignRow => (i >= 110 ? [r[0], 90, r[2], r[3], r[4], r[5], r[6], r[7], r[8]] : r));
    const ev3 = detectForeignEvents(rows3, pctl2);
    expect(ev3.map((e) => e.type)).toEqual(['sell_extreme']);
  });

  it('analyzeForeignChips：latest 含百分位，事件統計含基準', () => {
    const rows: ForeignRow[] = Array.from({ length: 200 }, (_, i) => [day(i), 100 + i, 1, 5, 20, -1000 - i, -1, 500 + i, 1]);
    const out = analyzeForeignChips(rows, new Date('2026-10-17T00:00:00Z'));
    expect(out.start).toBe(day(0));
    expect(out.end).toBe(day(199));
    expect(out.latest?.foreignOiPctl).toBe(0); // 持續創低 → 最低
    expect(out.latest?.retailOiPctl).toBe(1); // 持續創高 → 最高
    expect(out.baseline.n).toBe(200);
    expect(out.events.filter((e) => e.type === 'oi_short')).toHaveLength(1); // 首次進入極端後一直在極端，只標一次
    expect(out.events.filter((e) => e.type === 'retail_long')).toHaveLength(1);
  });
});
