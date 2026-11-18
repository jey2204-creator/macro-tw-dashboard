/** 線尾標籤字級（px） */
export const END_LABEL_FONT = 11;
/** 線尾標籤需要的右側留白（px）：最寬的標籤＋內距與左右邊距；量不到字寬（測試環境）時用每字 7px 估 */
export function endLabelGapPx(texts: readonly string[], fontFamily: string): number {
  let w = 0;
  const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext?.('2d') : null;
  if (ctx) ctx.font = `${END_LABEL_FONT}px ${fontFamily}`;
  for (const t of texts) w = Math.max(w, ctx ? ctx.measureText(t).width : t.length * 7);
  return Math.ceil(w) + 8 + 5 + 4;
}
/** 像素留白換算成 K 棒數：畫面寬 widthPx 要放 bars 根＋gapPx 留白 */
export function rightGapBars(widthPx: number, bars: number, gapPx: number): number {
  if (!(widthPx > gapPx) || bars <= 0) return 2;
  return Math.max(2, (gapPx * bars) / (widthPx - gapPx));
}
