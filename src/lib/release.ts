import type { EventView, IndicatorReleases } from '../shared/calendar';
import { formatTaipeiDateTime } from '../shared/dates';

const num = (v: number, d: number) => v.toFixed(d);

function fmt(v: EventView, x: number): string {
  const s = num(x, v.def.decimals);
  return v.def.unit === '%' ? `${s}%` : `${x > 0 ? '+' : ''}${s}k`;
}

function fmtDiff(v: EventView, d: number): string {
  const s = num(Math.abs(d), v.def.decimals);
  const u = v.def.unit === '%' ? 'pp' : 'k';
  return `${d > 0 ? '+' : '−'}${s}${u}`;
}

/** 公布時間：有時間顯示台北時間，否則只顯示美東日期 */
export function releaseWhen(v: EventView): string {
  if (v.event.releaseAt) return formatTaipeiDateTime(v.event.releaseAt);
  const [, m, d] = v.event.releaseDate.split('-');
  return `${m}/${d}`;
}

export interface ReleasePart {
  text: string;
  /** 驚奇方向：上／下（沿用網站漲跌顏色）；符合或未知為空 */
  dir: 'up' | 'down' | '';
  title: string;
}

/** 單項：「年增 3.7%（預期 3.6% ▲+0.1pp）」 */
export function releasePart(v: EventView): ReleasePart {
  const fc = v.event.forecast;
  const src = v.event.source === 'manual' ? '手動輸入' : 'ForexFactory';
  const title = `參考期間 ${v.event.period}｜預期來源：${src}${v.event.previous !== null ? `｜前值 ${fmt(v, v.event.previous)}` : ''}`;
  if (!v.released) {
    return { text: `${v.def.label} 預期 ${fc === null ? '—' : fmt(v, fc)}`, dir: '', title };
  }
  const actual = v.actual === null ? '待更新' : fmt(v, v.actual);
  if (fc === null) return { text: `${v.def.label} ${actual}`, dir: '', title };
  let tail = '';
  if (v.surprise === 'inline') tail = ' 符合';
  else if (v.diff !== null) tail = ` ${v.diff > 0 ? '▲' : '▼'}${fmtDiff(v, v.diff)}`;
  return {
    text: `${v.def.label} ${actual}（預期 ${fmt(v, fc)}${tail}）`,
    dir: v.surprise === 'above' ? 'up' : v.surprise === 'below' ? 'down' : '',
    title,
  };
}

export interface ReleaseLine {
  head: string;
  parts: ReleasePart[];
}

/** 列上顯示的公布資訊：最近一次已公布 + 下一次預定 */
export function releaseLines(r: IndicatorReleases | undefined): ReleaseLine[] {
  if (!r) return [];
  const lines: ReleaseLine[] = [];
  if (r.latest.length) lines.push({ head: `${releaseWhen(r.latest[0]!)} 公布`, parts: r.latest.map(releasePart) });
  if (r.next.length) {
    const withFc = r.next.filter((v) => v.event.forecast !== null);
    lines.push({ head: `下次 ${releaseWhen(r.next[0]!)}`, parts: withFc.map(releasePart) });
  }
  return lines;
}
