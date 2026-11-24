import type { Point } from './timeseries';

/**
 * 美國實質 GDP 成長（政策利率面板第五格「GDP 成長率」與讀數列用；參考、不計分）
 * - FRED A191RL1Q225SBEA 是「年化季增率」（SAAR），日期＝季度起始日；單季 2020 會到 −28%／+35%，畫圖會把刻度撐爆
 * - 改用連續四季複利換算「年增率」：∏(1 + q/100)^(1/4) − 1，與 BEA 公布的年增率（A191RO1Q156NBEA）差在 0.1pp 內（四捨五入）
 * - GDPNow（Atlanta Fed）是「當季」年化季增的即時估計，日期同為季度起始日；配上前三季實際值換算成推估年增
 */

/** 季度起始日 → 「26Q3」 */
export function quarterLabel(date: string): string {
  const m = Number(date.slice(5, 7));
  return `${date.slice(2, 4)}Q${Math.floor((m - 1) / 3) + 1}`;
}

/** 下一季的起始日（2026-10-01 → 2027-01-01） */
export function nextQuarter(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m >= 10 ? `${y + 1}-01-01` : `${y}-${String(m + 3).padStart(2, '0')}-01`;
}

const quarterFactor = (saar: number) => Math.pow(1 + saar / 100, 0.25);

/** 年化季增序列 → 年增率序列（需要連續四季；中間缺季就跳過） */
export function gdpYoy(saar: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 3; i < saar.length; i++) {
    let ok = true;
    for (let k = i - 2; k <= i; k++) if (nextQuarter(saar[k - 1]![0]) !== saar[k]![0]) ok = false;
    if (!ok) continue;
    let f = 1;
    for (let k = i - 3; k <= i; k++) f *= quarterFactor(saar[k]![1]);
    out.push([saar[i]![0], Math.round((f - 1) * 1000) / 10]);
  }
  return out;
}

export interface GdpNowcast {
  /** 所估計的季度起始日 */
  date: string;
  /** GDPNow 年化季增 */
  saar: number;
  /** 配上前三季實際值的推估年增；前三季不齊就是 null */
  yoy: number | null;
}

/** 最新一筆 GDPNow，只在它估的季度還沒有實際值時才回傳 */
export function gdpNowcast(saar: readonly Point[], now: readonly Point[]): GdpNowcast | null {
  const last = now.at(-1);
  const lastActual = saar.at(-1);
  if (!last || !lastActual || last[0] <= lastActual[0]) return null;
  let yoy: number | null = null;
  if (saar.length >= 3 && nextQuarter(lastActual[0]) === last[0]) {
    const prev = saar.slice(-3);
    if (nextQuarter(prev[0]![0]) === prev[1]![0] && nextQuarter(prev[1]![0]) === prev[2]![0]) {
      let f = quarterFactor(last[1]);
      for (const p of prev) f *= quarterFactor(p[1]);
      yoy = Math.round((f - 1) * 1000) / 10;
    }
  }
  return { date: last[0], saar: Math.round(last[1] * 10) / 10, yoy };
}

/** 10Y − 2Y 判讀：< 0 倒掛（歷來衰退前常見，但領先 6～24 個月、不準時） */
export function curveText(spread: number): string {
  return spread < 0 ? '倒掛' : spread < 0.5 ? '偏平' : '正斜率';
}
