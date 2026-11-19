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

/** 往左拖曳後，線尾標籤改標的那一根：時間與 x 座標 */
export interface FollowAnchor {
  time: string;
  x: number;
}
interface FollowScale {
  width(): number;
  coordinateToLogical(x: number): number | null;
  logicalToCoordinate(logical: never): number | null;
  coordinateToTime(x: number): unknown;
  timeToIndex(time: never, findNearest: boolean): number | null;
}
/**
 * 標籤欄（右側 gapPx）左緣落在哪一根：最新一根還在標籤欄左緣以內（沒往左拖）回傳 null＝照常標最新值；
 * 否則回傳那一根，標籤與讀數列改標那一天的數值（畫面往左移到哪、數值就跟到哪）
 */
export function followAnchor(ts: FollowScale, gapPx: number): FollowAnchor | null {
  if (!(gapPx > 0)) return null;
  const lastIdx = ts.timeToIndex('9999-12-31' as never, true);
  const logical = ts.coordinateToLogical(ts.width() - gapPx);
  if (lastIdx === null || logical === null) return null;
  // +0.05：沒拖曳時最新一根剛好在標籤欄左緣，浮點誤差不該被當成往左拖
  const idx = Math.floor(logical + 0.05);
  if (idx >= lastIdx || idx < 0) return null;
  const x = ts.logicalToCoordinate(idx as never);
  const prev = ts.logicalToCoordinate((idx - 1) as never);
  if (x === null) return null;
  // coordinateToTime 內部無條件進位到下一根 → 往左退一點再查
  const time = ts.coordinateToTime(x - (prev === null ? 0.5 : Math.min(0.5, (x - prev) * 0.3)));
  return typeof time === 'string' ? { time, x } : null;
}
