import type { Point } from '../shared/timeseries';

interface Props {
  points: Point[];
  width?: number;
  height?: number;
  /** 顏色依「近期方向」決定，與旁邊的方向文字一致 */
  dir?: 'up' | 'down' | 'flat';
}

/** 迷你走勢線（最近 N 筆），純 SVG，無互動 */
export function Sparkline({ points, width = 56, height = 18, dir }: Props) {
  if (points.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const vals = points.map((p) => p[1]);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = width / (vals.length - 1);
  const d = vals
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - 1 - ((v - min) / span) * (height - 2)).toFixed(1)}`)
    .join('');
  return (
    <svg width={width} height={height} className={`spark ${dir ?? ''}`} aria-hidden="true">
      <path d={d} fill="none" strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
