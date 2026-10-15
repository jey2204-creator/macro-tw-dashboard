import type { Category, Frequency } from './types';

/**
 * 指標註冊表 —— 整個專案唯一的指標設定來源。
 * 新增指標：在 INDICATORS 加一筆設定即可，抓取腳本與 UI 會自動處理。
 */

export type SourceSpec =
  | { provider: 'yahoo'; symbol: string }
  | { provider: 'fred'; symbol: string }
  | { provider: 'tpex'; symbol: 'TPEX_INDEX' }
  | { provider: 'twse'; symbol: 'TAIEX' }
  | { provider: 'taifex'; symbol: 'TXF_FOREIGN_OI' | 'MXF_RETAIL_OI' | 'TXO_FOREIGN_NET' | 'TX_TOP10_SPECIFIC' }
  | {
      provider: 'twse_chips';
      symbol:
        | 'FOREIGN'
        | 'TRUST'
        | 'DEALER'
        | 'MARGIN'
        | 'MARGIN_BALANCE'
        | 'MARGIN_RATIO'
        | 'LIMIT_UP'
        | 'LIMIT_DOWN'
        | 'ADVANCE'
        | 'DECLINE';
    };

/** 原始資料 → 顯示用數列的轉換 */
export type Transform =
  | 'none'
  | 'yoy' // 年增率 %（月資料，與 12 期前比較）
  | 'diff'; // 與前期差值（非農就業：千人）

export type SignalRule =
  /** 股價指數趨勢：收盤 vs MA60、MA60 斜率、收盤 vs MA240 */
  | { kind: 'trend' }
  /** N 期變化：上升代表對台股不利（殖利率、美元、台幣貶值、油價） */
  | {
      kind: 'risingIsBearish';
      lookback: number;
      mode: 'abs' | 'pct';
      /** 變化 ≥ bearAt → 偏空 */
      bearAt: number;
      /** 變化 ≤ bullAt → 偏多（null = 不會判為偏多） */
      bullAt: number | null;
    }
  /** 殖利率曲線：倒掛（< 0）→ 偏空 */
  | { kind: 'curve' }
  /** 政策利率：與 lookbackDays 前比較，降息 → 偏多，升息 → 偏空 */
  | { kind: 'policyRate'; lookbackDays: number }
  /** 通膨年增率趨勢：與 lookback 期前比較 */
  | { kind: 'inflationTrend'; lookback: number; threshold: number }
  /** 失業率 Sahm 法則；bullBelow=null 表示不判偏多（落後指標） */
  | { kind: 'sahm'; bullBelow: number | null }
  /** 非農就業 3 個月平均新增（千人）；bullAt=null 表示不判偏多 */
  | { kind: 'payrolls'; bullAt: number | null; bearAt: number }
  /** 經濟成長率（年化季增 %） */
  | { kind: 'growth'; bullAt: number; bearAt: number }
  /** 僅供參考：不判多空，只顯示近期累計（台股籌碼，待回測驗證） */
  | { kind: 'info' };

export interface IndicatorDef {
  id: string;
  name: string;
  /** 小螢幕使用的短名稱 */
  short: string;
  category: Category;
  frequency: Frequency;
  /** 顯示單位 */
  unit: '%' | 'pt' | 'USD' | 'TWD' | 'k' | '口' | '億' | '家';
  decimals: number;
  /** 依優先順序排列；第一個失敗會嘗試下一個 */
  sources: SourceSpec[];
  transform: Transform;
  /** 是否為市場型（有日變化、可畫 K 線） */
  market: boolean;
  /** 利率類：變化以 bp 顯示 */
  changeInBp?: boolean;
  rule: SignalRule;
  /** 綜合判斷權重（0 = 僅顯示不計分） */
  weight: number;
  /** 超過此天數未更新 → 視為過時，不納入綜合判斷 */
  maxAgeDays: number;
  /** 一句話說明此指標與台股的關係 */
  note: string;
  /** 只抓取不單獨顯示（例如 Fed 目標區間下緣） */
  hidden?: boolean;
  /** 搭配顯示的另一個指標（Fed 區間下緣） */
  pairId?: string;
  /** 不另外抓取，沿用此指標的資料（再套用 transform） */
  derivedFrom?: string;
  /** 每日流量型（買賣超、增減）：近期方向看「N 日累計」 */
  flow?: boolean;
  /** 圖表型式（非市場型預設依 transform 決定） */
  chart?: 'line' | 'histogram';
  /** 圖表參考線（例如融資維持率 130%／140%／170%） */
  refLines?: { value: number; label: string }[];
  /** 依數值分區的說明（由低到高，取第一個 value < max 的區間） */
  zones?: { max: number; label: string }[];
}

export const CATEGORY_LABEL: Record<Category, string> = {
  rates: '美債利率',
  fx: '美元／匯率',
  energy: '能源',
  macro: '美國總經',
  us_equity: '美股',
  tw_equity: '台股',
  tw_chips: '台股籌碼',
};

export const CATEGORY_ORDER: Category[] = ['tw_equity', 'tw_chips', 'us_equity', 'rates', 'fx', 'energy', 'macro'];

/**
 * 權重與規則依 2010–2026 回測審查後調整（2026-10，scripts/fetch-data/backtest.ts）：
 *  - 利率與通膨（2Y、10Y、核心 CPI、Fed）前後兩段皆穩定有效 → 權重 1
 *  - 股價趨勢對未來 60 日幾乎無預測力 → 權重 0.25–0.5，且需三項一致才判多空
 *  - 失業率、非農為落後指標 → 不判偏多，權重 0.5
 *  - 利差、油價觸發樣本太少 → 權重 0（僅供參考）
 */
export const INDICATORS: IndicatorDef[] = [
  // ── 美債利率 ───────────────────────────────
  {
    id: 'us2y', name: '美國 2 年期公債殖利率', short: '美債2Y', category: 'rates', frequency: 'daily',
    unit: '%', decimals: 2, sources: [{ provider: 'fred', symbol: 'DGS2' }], transform: 'none',
    market: true, changeInBp: true,
    rule: { kind: 'risingIsBearish', lookback: 20, mode: 'abs', bearAt: 0.2, bullAt: -0.2 },
    weight: 1, maxAgeDays: 7, note: '反映 Fed 政策預期；快速上升代表緊縮預期升溫',
  },
  {
    id: 'us10y', name: '美國 10 年期公債殖利率', short: '美債10Y', category: 'rates', frequency: 'daily',
    unit: '%', decimals: 2, sources: [{ provider: 'fred', symbol: 'DGS10' }], transform: 'none',
    market: true, changeInBp: true,
    rule: { kind: 'risingIsBearish', lookback: 20, mode: 'abs', bearAt: 0.2, bullAt: -0.2 },
    weight: 1, maxAgeDays: 7, note: '全球資產定價錨；急升壓抑科技股評價',
  },
  {
    id: 'spread', name: '10Y−2Y 利差', short: '10Y-2Y', category: 'rates', frequency: 'daily',
    unit: '%', decimals: 2, sources: [{ provider: 'fred', symbol: 'T10Y2Y' }], transform: 'none',
    market: true, changeInBp: true, rule: { kind: 'curve' },
    weight: 0, maxAgeDays: 7, note: '負值＝殖利率曲線倒掛，常領先景氣衰退；回測觸發樣本太少，僅供參考不計分',
  },
  // ── 美元／匯率 ─────────────────────────────
  {
    id: 'dxy', name: '美元指數 DXY', short: 'DXY', category: 'fx', frequency: 'daily',
    unit: 'pt', decimals: 2, sources: [{ provider: 'yahoo', symbol: 'DX-Y.NYB' }], transform: 'none',
    market: true,
    rule: { kind: 'risingIsBearish', lookback: 20, mode: 'pct', bearAt: 1.5, bullAt: -1.5 },
    weight: 0.5, maxAgeDays: 5, note: '美元走強通常伴隨資金撤出新興市場',
  },
  {
    id: 'usdtwd', name: '美元／新台幣', short: 'USD/TWD', category: 'fx', frequency: 'daily',
    unit: 'TWD', decimals: 3,
    sources: [{ provider: 'yahoo', symbol: 'TWD=X' }, { provider: 'fred', symbol: 'DEXTAUS' }],
    transform: 'none', market: true,
    rule: { kind: 'risingIsBearish', lookback: 20, mode: 'pct', bearAt: 1.5, bullAt: -1.5 },
    weight: 0.5, maxAgeDays: 10, note: '數值上升＝台幣貶值，常反映外資匯出',
  },
  // ── 能源 ──────────────────────────────────
  {
    id: 'wti', name: 'WTI 原油', short: 'WTI', category: 'energy', frequency: 'daily',
    unit: 'USD', decimals: 2,
    sources: [{ provider: 'yahoo', symbol: 'CL=F' }, { provider: 'fred', symbol: 'DCOILWTICO' }],
    transform: 'none', market: true,
    rule: { kind: 'risingIsBearish', lookback: 20, mode: 'pct', bearAt: 15, bullAt: null },
    weight: 0, maxAgeDays: 10, note: '油價急漲推升通膨預期與利率；回測觸發樣本太少，僅供參考不計分',
  },
  {
    id: 'brent', name: 'Brent 原油', short: 'Brent', category: 'energy', frequency: 'daily',
    unit: 'USD', decimals: 2,
    sources: [{ provider: 'yahoo', symbol: 'BZ=F' }, { provider: 'fred', symbol: 'DCOILBRENTEU' }],
    transform: 'none', market: true,
    rule: { kind: 'risingIsBearish', lookback: 20, mode: 'pct', bearAt: 15, bullAt: null },
    weight: 0, maxAgeDays: 10, note: '國際油價基準，與 WTI 互相驗證；僅供參考不計分',
  },
  // ── 美國總經 ───────────────────────────────
  {
    id: 'fed', name: 'Fed 政策利率（目標區間）', short: 'Fed利率', category: 'macro', frequency: 'daily',
    unit: '%', decimals: 2, sources: [{ provider: 'fred', symbol: 'DFEDTARU' }], transform: 'none',
    market: false, changeInBp: true, rule: { kind: 'policyRate', lookbackDays: 120 },
    weight: 1, maxAgeDays: 10, note: '降息循環通常有利風險資產評價', pairId: 'fed_lower',
  },
  {
    id: 'fed_lower', name: 'Fed 目標區間下緣', short: 'Fed下緣', category: 'macro', frequency: 'daily',
    unit: '%', decimals: 2, sources: [{ provider: 'fred', symbol: 'DFEDTARL' }], transform: 'none',
    market: false, rule: { kind: 'policyRate', lookbackDays: 120 }, weight: 0, maxAgeDays: 10,
    note: '', hidden: true,
  },
  {
    id: 'cpi', name: 'CPI 年增率', short: 'CPI', category: 'macro', frequency: 'monthly',
    unit: '%', decimals: 1, sources: [{ provider: 'fred', symbol: 'CPIAUCNS' }], transform: 'yoy',
    market: false, rule: { kind: 'inflationTrend', lookback: 3, threshold: 0.2 },
    weight: 0.5, maxAgeDays: 75, note: '整體通膨；趨勢下降給 Fed 降息空間（年增率用未季調指數，與 BLS 新聞稿一致）',
  },
  {
    id: 'core_cpi', name: '核心 CPI 年增率', short: '核心CPI', category: 'macro', frequency: 'monthly',
    unit: '%', decimals: 1, sources: [{ provider: 'fred', symbol: 'CPILFENS' }], transform: 'yoy',
    market: false, rule: { kind: 'inflationTrend', lookback: 3, threshold: 0.2 },
    weight: 1, maxAgeDays: 75, note: '排除食品能源，Fed 更重視的通膨指標（年增率用未季調指數，與 BLS 新聞稿一致）',
  },
  // 月增率用季調指數（市場預期的月增率以季調為準）；只抓取、不單獨顯示
  {
    id: 'cpi_sa', name: 'CPI 指數（季調）', short: 'CPI季調', category: 'macro', frequency: 'monthly',
    unit: 'pt', decimals: 3, sources: [{ provider: 'fred', symbol: 'CPIAUCSL' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 75, note: '', hidden: true,
  },
  {
    id: 'core_cpi_sa', name: '核心 CPI 指數（季調）', short: '核心季調', category: 'macro', frequency: 'monthly',
    unit: 'pt', decimals: 3, sources: [{ provider: 'fred', symbol: 'CPILFESL' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 75, note: '', hidden: true,
  },
  {
    id: 'unrate', name: '美國失業率', short: '失業率', category: 'macro', frequency: 'monthly',
    unit: '%', decimals: 1, sources: [{ provider: 'fred', symbol: 'UNRATE' }], transform: 'none',
    market: false, changeInBp: false, rule: { kind: 'sahm', bullBelow: null },
    weight: 0.5, maxAgeDays: 75, note: 'Sahm 法則：3月均值較前12月低點升 ≥0.5pp 為衰退訊號',
  },
  {
    id: 'nfp', name: '非農就業新增', short: '非農', category: 'macro', frequency: 'monthly',
    unit: 'k', decimals: 0, sources: [{ provider: 'fred', symbol: 'PAYEMS' }], transform: 'diff',
    market: false, rule: { kind: 'payrolls', bullAt: null, bearAt: 0 },
    weight: 0.5, maxAgeDays: 75, note: '每月新增就業人數（千人）；以 3 個月平均判斷',
  },
  {
    id: 'gdp', name: '美國實質 GDP（年化季增）', short: '實質GDP', category: 'macro', frequency: 'quarterly',
    unit: '%', decimals: 1, sources: [{ provider: 'fred', symbol: 'A191RL1Q225SBEA' }], transform: 'none',
    market: false, rule: { kind: 'growth', bullAt: 2, bearAt: 0 },
    weight: 0.5, maxAgeDays: 230, note: 'BEA 公布之實質 GDP 年化季增率（季度結束約 1 個月後初值）',
  },
  {
    id: 'gdpnow', name: 'Atlanta Fed GDPNow', short: 'GDPNow', category: 'macro', frequency: 'quarterly',
    unit: '%', decimals: 1, sources: [{ provider: 'fred', symbol: 'GDPNOW' }], transform: 'none',
    market: false, rule: { kind: 'growth', bullAt: 2, bearAt: 0 },
    weight: 0.5, maxAgeDays: 200, note: '當季 GDP 即時預估（日期為所預估的季度起始日）',
  },
  // ── 美股 ──────────────────────────────────
  {
    id: 'spx', name: 'S&P 500', short: 'S&P500', category: 'us_equity', frequency: 'daily',
    unit: 'pt', decimals: 2,
    sources: [{ provider: 'yahoo', symbol: '^GSPC' }, { provider: 'fred', symbol: 'SP500' }],
    transform: 'none', market: true, rule: { kind: 'trend' }, weight: 0.25, maxAgeDays: 5,
    note: '美股大盤風險偏好',
  },
  {
    id: 'nasdaq', name: 'NASDAQ 綜合指數', short: 'NASDAQ', category: 'us_equity', frequency: 'daily',
    unit: 'pt', decimals: 2,
    sources: [{ provider: 'yahoo', symbol: '^IXIC' }, { provider: 'fred', symbol: 'NASDAQCOM' }],
    transform: 'none', market: true, rule: { kind: 'trend' }, weight: 0.25, maxAgeDays: 5,
    note: '科技股風向，與台股電子權值連動高',
  },
  {
    id: 'sox', name: '費城半導體指數', short: '費半SOX', category: 'us_equity', frequency: 'daily',
    unit: 'pt', decimals: 2, sources: [{ provider: 'yahoo', symbol: '^SOX' }], transform: 'none',
    market: true, rule: { kind: 'trend' }, weight: 0.5, maxAgeDays: 5,
    note: '與台股（半導體權重高）連動最直接',
  },
  // ── 台股 ──────────────────────────────────
  {
    id: 'taiex', name: '台灣加權指數', short: '加權指數', category: 'tw_equity', frequency: 'daily',
    unit: 'pt', decimals: 2,
    sources: [{ provider: 'yahoo', symbol: '^TWII' }, { provider: 'twse', symbol: 'TAIEX' }],
    transform: 'none', market: true, rule: { kind: 'trend' }, weight: 0.5, maxAgeDays: 5,
    note: '台股大盤自身趨勢',
  },
  {
    id: 'tpex', name: '櫃買指數', short: '櫃買指數', category: 'tw_equity', frequency: 'daily',
    unit: 'pt', decimals: 2, sources: [{ provider: 'tpex', symbol: 'TPEX_INDEX' }], transform: 'none',
    market: true, rule: { kind: 'trend' }, weight: 0.25, maxAgeDays: 5,
    note: '中小型股風險偏好',
  },
  // ── 台股籌碼（僅供參考，權重 0；待回測驗證後再決定是否計分） ──
  {
    id: 'fut_foreign_oi', name: '外資台指期淨未平倉', short: '外資期淨OI', category: 'tw_chips', frequency: 'daily',
    unit: '口', decimals: 0, sources: [{ provider: 'taifex', symbol: 'TXF_FOREIGN_OI' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, chart: 'line',
    note: '外資在臺股期貨（大台）的多空未平倉口數淨額；負值為淨空單。外資空單常是現貨避險，不等於看空',
  },
  {
    id: 'fut_foreign_oi_chg', name: '外資台指期淨未平倉增減', short: '外資期增減', category: 'tw_chips', frequency: 'daily',
    unit: '口', decimals: 0, sources: [{ provider: 'taifex', symbol: 'TXF_FOREIGN_OI' }], transform: 'diff',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, derivedFrom: 'fut_foreign_oi', flow: true,
    chart: 'histogram', note: '與前一交易日相比的淨未平倉變化；正值＝多單增加或空單回補',
  },
  {
    id: 'opt_foreign_net', name: '外資台指選擇權多空淨金額', short: '外資選擇權', category: 'tw_chips', frequency: 'daily',
    unit: '億', decimals: 2, sources: [{ provider: 'taifex', symbol: 'TXO_FOREIGN_NET' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, chart: 'line',
    note: '外資 CALL 未平倉金額淨額 − PUT 未平倉金額淨額（億元）；正值偏多、負值偏空。看金額不看口數；週選擇權結算日前後會劇烈跳動',
  },
  {
    id: 'top10_specific_oi', name: '前十大特定法人台指期淨未平倉', short: '十大法人期', category: 'tw_chips', frequency: 'daily',
    unit: '口', decimals: 0, sources: [{ provider: 'taifex', symbol: 'TX_TOP10_SPECIFIC' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, chart: 'line',
    note: '大額交易人資料：所有月份合計、前十大特定法人買方 − 賣方（大台約當，含小台÷4、微台÷20）。特定法人以外資為主，可與外資台指期互相驗證',
  },
  {
    id: 'top10_specific_oi_chg', name: '前十大特定法人台指期淨未平倉增減', short: '十大法人增減', category: 'tw_chips',
    frequency: 'daily', unit: '口', decimals: 0, sources: [{ provider: 'taifex', symbol: 'TX_TOP10_SPECIFIC' }],
    transform: 'diff', market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, derivedFrom: 'top10_specific_oi',
    flow: true, chart: 'histogram', note: '與前一交易日相比的前十大特定法人淨未平倉變化',
  },
  {
    id: 'retail_oi', name: '散戶小台淨未平倉（推算）', short: '散戶小台OI', category: 'tw_chips', frequency: 'daily',
    unit: '口', decimals: 0, sources: [{ provider: 'taifex', symbol: 'MXF_RETAIL_OI' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, chart: 'line',
    note: '推算值：−（三大法人小台淨未平倉合計）。常被當作反向指標：散戶大量偏多時需留意',
  },
  {
    id: 'retail_oi_chg', name: '散戶小台淨未平倉增減（推算）', short: '散戶增減', category: 'tw_chips', frequency: 'daily',
    unit: '口', decimals: 0, sources: [{ provider: 'taifex', symbol: 'MXF_RETAIL_OI' }], transform: 'diff',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, derivedFrom: 'retail_oi', flow: true,
    chart: 'histogram', note: '與前一交易日相比的散戶小台淨未平倉變化',
  },
  {
    id: 'net_foreign', name: '外資買賣超（上市）', short: '外資買賣超', category: 'tw_chips', frequency: 'daily',
    unit: '億', decimals: 2, sources: [{ provider: 'twse_chips', symbol: 'FOREIGN' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, flow: true, chart: 'histogram',
    note: '外資及陸資＋外資自營商買賣差額（億元，上市市場）',
  },
  {
    id: 'net_trust', name: '投信買賣超（上市）', short: '投信買賣超', category: 'tw_chips', frequency: 'daily',
    unit: '億', decimals: 2, sources: [{ provider: 'twse_chips', symbol: 'TRUST' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, flow: true, chart: 'histogram',
    note: '投信買賣差額（億元，上市市場）；季底常有作帳行情',
  },
  {
    id: 'net_dealer', name: '自營商買賣超（上市）', short: '自營商買賣超', category: 'tw_chips', frequency: 'daily',
    unit: '億', decimals: 2, sources: [{ provider: 'twse_chips', symbol: 'DEALER' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, flow: true, chart: 'histogram',
    note: '自營商（自行買賣＋避險）買賣差額（億元）；避險部位多與權證、期權相關',
  },
  {
    id: 'margin_balance', name: '融資餘額（上市）', short: '融資餘額', category: 'tw_chips', frequency: 'daily',
    unit: '億', decimals: 1, sources: [{ provider: 'twse_chips', symbol: 'MARGIN_BALANCE' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, chart: 'line',
    note: '上市融資金額今日餘額（億元）；餘額持續創高代表散戶槓桿累積',
  },
  {
    id: 'margin_ratio', name: '大盤融資維持率（上市，推算）', short: '融資維持率', category: 'tw_chips', frequency: 'daily',
    unit: '%', decimals: 2, sources: [{ provider: 'twse_chips', symbol: 'MARGIN_RATIO' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, chart: 'line',
    refLines: [
      { value: 130, label: '追繳 130%' },
      { value: 140, label: '警戒 140%' },
      { value: 170, label: '過熱 170%' },
    ],
    zones: [
      { max: 130, label: '低於追繳線' },
      { max: 140, label: '斷頭警戒區' },
      { max: 160, label: '偏低' },
      { max: 170, label: '正常' },
      { max: Infinity, label: '偏熱' },
    ],
    note: '推算值＝Σ(逐檔融資餘額×收盤價)÷融資金額，上市含ETF。跌破140%常伴隨斷頭賣壓、接近階段低點；不代表會立刻反彈',
  },
  {
    id: 'margin_chg', name: '融資餘額增減（上市）', short: '融資增減', category: 'tw_chips', frequency: 'daily',
    unit: '億', decimals: 2, sources: [{ provider: 'twse_chips', symbol: 'MARGIN' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, flow: true, chart: 'histogram',
    note: '融資金額今日餘額 − 前日餘額（億元）；融資快速增加代表散戶槓桿升溫',
  },
  {
    id: 'limit_up', name: '漲停家數（上市股票）', short: '漲停家數', category: 'tw_chips', frequency: 'daily',
    unit: '家', decimals: 0, sources: [{ provider: 'twse_chips', symbol: 'LIMIT_UP' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, chart: 'histogram', flow: true,
    note: '收盤漲停的上市普通股家數（不含 ETF、權證）；跌勢中漲停多於跌停常是止跌跡象',
  },
  {
    id: 'limit_down', name: '跌停家數（上市股票）', short: '跌停家數', category: 'tw_chips', frequency: 'daily',
    unit: '家', decimals: 0, sources: [{ provider: 'twse_chips', symbol: 'LIMIT_DOWN' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, chart: 'histogram', flow: true,
    note: '收盤跌停的上市普通股家數；暴增代表恐慌或斷頭賣壓，常在階段低點附近，但不一定是最後一天',
  },
  {
    id: 'advance', name: '上漲家數（上市股票）', short: '上漲家數', category: 'tw_chips', frequency: 'daily',
    unit: '家', decimals: 0, sources: [{ provider: 'twse_chips', symbol: 'ADVANCE' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, hidden: true,
    note: '上漲的上市普通股家數（含漲停）',
  },
  {
    id: 'decline', name: '下跌家數（上市股票）', short: '下跌家數', category: 'tw_chips', frequency: 'daily',
    unit: '家', decimals: 0, sources: [{ provider: 'twse_chips', symbol: 'DECLINE' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, hidden: true,
    note: '下跌的上市普通股家數（含跌停）',
  },
];

export const INDICATOR_MAP: Record<string, IndicatorDef> = Object.fromEntries(
  INDICATORS.map((d) => [d.id, d]),
);

export function getIndicator(id: string): IndicatorDef {
  const def = INDICATOR_MAP[id];
  if (!def) throw new Error(`未知指標：${id}`);
  return def;
}

/** 來源的人類可讀網址 */
export function sourceUrl(spec: SourceSpec): string {
  switch (spec.provider) {
    case 'yahoo':
      return `https://finance.yahoo.com/quote/${encodeURIComponent(spec.symbol)}`;
    case 'fred':
      return `https://fred.stlouisfed.org/series/${spec.symbol}`;
    case 'tpex':
      return 'https://www.tpex.org.tw/openapi/'; // 官方 OpenAPI 文件（櫃買指數歷史資料）
    case 'twse':
      return 'https://www.twse.com.tw/zh/';
    case 'taifex':
      if (spec.symbol === 'TXO_FOREIGN_NET') return 'https://www.taifex.com.tw/cht/3/callsAndPutsDate';
      if (spec.symbol === 'TX_TOP10_SPECIFIC') return 'https://www.taifex.com.tw/cht/3/largeTraderFutQry';
      return 'https://www.taifex.com.tw/cht/3/futContractsDate';
    case 'twse_chips':
      return 'https://www.twse.com.tw/zh/';
  }
}

export const PROVIDER_LABEL: Record<SourceSpec['provider'], string> = {
  yahoo: 'Yahoo Finance',
  fred: 'FRED（St. Louis Fed）',
  tpex: '櫃買中心 TPEx',
  twse: '臺灣證交所 TWSE',
  taifex: '臺灣期交所 TAIFEX',
  twse_chips: '臺灣證交所 TWSE',
};
