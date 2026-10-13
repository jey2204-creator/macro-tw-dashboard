import type { IndicatorDef } from '../shared/indicators';

const nf = new Map<number, Intl.NumberFormat>();
function num(v: number, d: number): string {
  let f = nf.get(d);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    nf.set(d, f);
  }
  return f.format(v);
}

export function formatValue(def: Pick<IndicatorDef, 'unit' | 'decimals'>, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = num(v, def.decimals);
  if (def.unit === '%') return `${s}%`;
  if (def.unit === 'k') return `${v >= 0 ? '+' : ''}${s}k`;
  if (def.unit === '億') return `${s}億`;
  if (def.unit === '口') return `${s}口`;
  return s;
}

/** 變化量：利率以 bp、百分比類以 pp、其他以絕對值 + 百分比 */
export function formatChange(
  def: Pick<IndicatorDef, 'unit' | 'decimals' | 'changeInBp'>,
  abs: number | null,
  pct: number | null,
): { main: string; sub: string | null } {
  if (abs === null || !Number.isFinite(abs)) return { main: '—', sub: null };
  const sign = abs > 0 ? '+' : abs < 0 ? '' : '±';
  if (def.changeInBp) return { main: `${sign}${num(abs * 100, 0)}bp`, sub: null };
  if (def.unit === '%') return { main: `${sign}${num(abs, def.decimals)}pp`, sub: null };
  if (def.unit === 'k') return { main: `${sign}${num(abs, 0)}k`, sub: null };
  if (def.unit === '口') return { main: `${sign}${num(abs, 0)}口`, sub: null };
  if (def.unit === '億') return { main: `${sign}${num(abs, def.decimals)}億`, sub: null };
  const p = pct === null ? null : `${pct > 0 ? '+' : pct < 0 ? '' : '±'}${num(pct, 2)}%`;
  return { main: p ?? `${sign}${num(abs, def.decimals)}`, sub: `${sign}${num(abs, def.decimals)}` };
}

/** 2026-10-06 → 10/06；非今年則 26/10/06 */
export function shortDate(d: string | null | undefined, today?: string): string {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  if (today && today.slice(0, 4) === y) return `${m}/${day}`;
  return `${y!.slice(2)}/${m}/${day}`;
}

/** 帶正負號與單位（流量型累計值） */
export function formatSigned(def: Pick<IndicatorDef, 'unit' | 'decimals'>, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const u = def.unit === '億' || def.unit === '口' ? def.unit : '';
  return `${v > 0 ? '+' : ''}${num(v, def.decimals)}${u}`;
}
