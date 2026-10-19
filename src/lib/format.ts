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
  if (def.unit === 'pp') return `${v > 0 ? '+' : ''}${s}pp`;
  if (def.unit === '分') return `${s}分`;
  if (def.unit === '倍') return `${s}倍`;
  if (def.unit === 'k') return `${v >= 0 ? '+' : ''}${s}k`;
  if (def.unit === '億') return `${s}億`;
  if (def.unit === '口') return `${s}口`;
  if (def.unit === '家') return `${s}家`;
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
  if (def.unit === '%' || def.unit === 'pp') return { main: `${sign}${num(abs, def.decimals)}pp`, sub: null };
  if (def.unit === 'k') return { main: `${sign}${num(abs, 0)}k`, sub: null };
  if (def.unit === '口' || def.unit === '家' || def.unit === '分') return { main: `${sign}${num(abs, 0)}${def.unit}`, sub: null };
  if (def.unit === '億' || def.unit === '倍') return { main: `${sign}${num(abs, def.decimals)}${def.unit}`, sub: null };
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

/**
 * 指標列短名後的日期標籤，依資料頻率區分「資料截止日」與「數據所屬期間」：
 * - 日資料（FRED 每個營業日一筆、Yahoo 收盤）：「至 10/16」＝最後一筆資料日，不是公布日或事件日（Fed 9/17 升息，列上仍顯示「至 10/16」）
 * - 月資料：「9月」＝該筆數據所屬月份（跨年才加年份）
 * - 季資料：「2026Q3」
 */
export function dataDateLabel(
  frequency: IndicatorDef['frequency'],
  d: string | null | undefined,
  today?: string,
): { text: string; title: string } {
  if (!d) return { text: '—', title: '沒有資料' };
  const [y, m] = d.split('-');
  if (frequency === 'monthly') {
    const mon = `${Number(m)}月`;
    const text = today && today.slice(0, 4) === y ? mon : `${y!.slice(2)}年${mon}`;
    return { text, title: `數據所屬月份：${y} 年 ${Number(m)} 月` };
  }
  if (frequency === 'quarterly') {
    const q = Math.floor((Number(m) - 1) / 3) + 1;
    return { text: `${y}Q${q}`, title: `數據所屬季度：${y} 年第 ${q} 季` };
  }
  return { text: shortDate(d, today), title: `資料截止日：${d}（最後一筆資料的日期，不是事件或公布日）` };
}

/** 帶正負號與單位（流量型累計值） */
export function formatSigned(def: Pick<IndicatorDef, 'unit' | 'decimals'>, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const u = def.unit === '億' || def.unit === '口' || def.unit === '家' || def.unit === '分' || def.unit === '倍' ? def.unit : def.unit === 'pp' ? 'pp' : '';
  return `${v > 0 && def.unit !== '家' ? '+' : ''}${num(v, def.decimals)}${u}`;
}
