/** 斷頭／漲跌停監測面板共用的格式工具 */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}
export const f2 = (v: number | null | undefined, sign = false) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${sign && v > 0 ? '+' : ''}${v.toFixed(2)}`;
export const pctCell = (v: number | null, sign = true) => (v === null ? '—' : `${sign && v > 0 ? '+' : ''}${v.toFixed(1)}%`);
