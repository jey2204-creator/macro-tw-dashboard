import type { Bar } from './types';

/** 指數的 [開, 高, 低]；收盤在各面板 rows[i][1] */
export type IndexOhl = [open: number, high: number, low: number];

/**
 * 取出每一列（[日期, 收盤, …]）對應的指數 [開, 高, 低]，給面板第 1 格畫 K 線用。
 * 缺值或不合理的值以收盤補上，並保證 高 ≥ max(開, 收)、低 ≤ min(開, 收)，K 棒才不會畫壞。
 * 幾乎沒有一天「高 > 低」（來源只有收盤價）時回傳 null：畫出來只是一排橫線，不如不提供。
 */
export function indexOhl(rows: readonly (readonly [string, number, ...unknown[]])[], bars: Bar[]): IndexOhl[] | null {
  const byDate = new Map(bars.map((b) => [b[0], b]));
  let real = 0;
  const out = rows.map((r): IndexOhl => {
    const c = r[1];
    const b = byDate.get(r[0]);
    const ok = (v: number | undefined) => (v !== undefined && Number.isFinite(v) && v > 0 ? v : c);
    const o = ok(b?.[1]);
    const h = Math.max(ok(b?.[2]), o, c);
    const l = Math.min(ok(b?.[3]), o, c);
    if (h > l) real++;
    return [o, h, l];
  });
  return rows.length > 0 && real / rows.length >= 0.5 ? out : null;
}
