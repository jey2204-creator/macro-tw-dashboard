/** 加權均線多空狀態（參考、不計分）：短線看 MA10/MA20、中期看 MA60/MA120、長期看 MA240 */
export type TrendSide = 'bull' | 'bear' | 'mixed';
export type MaTrend = {
  short: TrendSide | null;
  mid: TrendSide | null;
  long: 'above' | 'below' | null;
  /** 收盤相對均線的乖離（%） */
  dev: { 20: number | null; 60: number | null; 240: number | null };
};
export type MaInputs = { close: number; 10?: number | null; 20?: number | null; 60?: number | null; 120?: number | null; 240?: number | null };

const pct = (close: number, ma: number | null | undefined) => (ma == null || ma === 0 ? null : (close / ma - 1) * 100);

/** 價在快線上且快線在慢線上＝多；兩者皆反向＝空；不一致＝整理 */
function side(close: number, fast: number | null | undefined, slow: number | null | undefined, priceRef: number | null | undefined): TrendSide | null {
  if (fast == null || slow == null || priceRef == null) return null;
  if (close > priceRef && fast > slow) return 'bull';
  if (close < priceRef && fast < slow) return 'bear';
  return 'mixed';
}

export function maTrend(m: MaInputs): MaTrend {
  const { close } = m;
  return {
    // 短線：收盤 vs MA20，MA10 vs MA20
    short: side(close, m[10], m[20], m[20]),
    // 中期：收盤 vs MA60（季線），MA60 vs MA120（半年線）
    mid: side(close, m[60], m[120], m[60]),
    long: m[240] == null ? null : close >= m[240] ? 'above' : 'below',
    dev: { 20: pct(close, m[20]), 60: pct(close, m[60]), 240: pct(close, m[240]) },
  };
}

export const TREND_TEXT = {
  short: { bull: '短多', bear: '短空', mixed: '短線整理' },
  mid: { bull: '中多', bear: '中空', mixed: '中期整理' },
  long: { above: '年線上', below: '年線下' },
} as const;
