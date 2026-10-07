import type { BacktestBucket, BacktestStats } from '../shared/types';

export const pct = (v: number | null, signed = false) =>
  v === null ? '—' : `${signed && v > 0 ? '+' : ''}${v.toFixed(signed ? 2 : 0)}%`;

export function bucketText(b: BacktestBucket | undefined): string {
  if (!b || b.days === 0) return '無樣本';
  return `之後60日加權平均 ${pct(b.avg60, true)}、上漲機率 ${pct(b.win60)}`;
}


/** 偏多與偏空之後 60 日平均報酬差（百分點）；任一狀態無樣本則為 null */
export function bullBearSpread(s: BacktestStats | undefined): number | null {
  if (!s || !s.bull.days || !s.bear.days || s.bull.avg60 === null || s.bear.avg60 === null) return null;
  return s.bull.avg60 - s.bear.avg60;
}
