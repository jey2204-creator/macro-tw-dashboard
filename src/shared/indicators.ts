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
  | { provider: 'naver_kr'; symbol: 'KOSPI_FOREIGN' }
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
  /** 列表短名下方的一行中文說明（縮寫是什麼、看什麼），省略則不顯示 */
  subtitle?: string;
  category: Category;
  frequency: Frequency;
  /** 顯示單位 */
  unit: '%' | 'pt' | 'USD' | 'TWD' | 'KRW' | 'JPY' | 'k' | '口' | '億' | '家';
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
  /** 數值越大越偏空（跌停、下跌家數）：漲跌顏色反轉，用空方色 */
  bearish?: boolean;
}

/** 依多空語意決定顏色 class：一般指標上升＝up；bearish 指標上升＝down（隨紅漲綠跌設定切換） */
export function toneClass(def: Pick<IndicatorDef, 'bearish'>, dir: 'up' | 'down' | 'flat' | ''): 'up' | 'down' | '' {
  if (dir !== 'up' && dir !== 'down') return '';
  if (!def.bearish) return dir;
  return dir === 'up' ? 'down' : 'up';
}

export const CATEGORY_LABEL: Record<Category, string> = {
  rates: '美債利率',
  fx: '美元／匯率',
  energy: '能源',
  commodity: '原物料',
  macro: '美國總經',
  us_equity: '美股',
  asia_equity: '亞股',
  tw_equity: '台股',
  tw_chips: '台股籌碼',
};

export const CATEGORY_ORDER: Category[] = ['tw_equity', 'tw_chips', 'us_equity', 'asia_equity', 'rates', 'fx', 'energy', 'commodity', 'macro'];

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
    subtitle: '美債2年殖利率｜Fed 預期',
    unit: '%', decimals: 2, sources: [{ provider: 'fred', symbol: 'DGS2' }], transform: 'none',
    market: true, changeInBp: true,
    rule: { kind: 'risingIsBearish', lookback: 20, mode: 'abs', bearAt: 0.2, bullAt: -0.2 },
    weight: 1, maxAgeDays: 7, note: '反映 Fed 政策預期；快速上升代表緊縮預期升溫',
  },
  {
    id: 'us10y', name: '美國 10 年期公債殖利率', short: '美債10Y', category: 'rates', frequency: 'daily',
    subtitle: '美債10年殖利率｜定價錨',
    unit: '%', decimals: 2, sources: [{ provider: 'fred', symbol: 'DGS10' }], transform: 'none',
    market: true, changeInBp: true,
    rule: { kind: 'risingIsBearish', lookback: 20, mode: 'abs', bearAt: 0.2, bullAt: -0.2 },
    weight: 1, maxAgeDays: 7, note: '全球資產定價錨；急升壓抑科技股評價',
  },
  {
    id: 'spread', name: '10Y−2Y 利差', short: '10Y-2Y', category: 'rates', frequency: 'daily',
    subtitle: '10年減2年利差｜倒掛＝衰退',
    unit: '%', decimals: 2, sources: [{ provider: 'fred', symbol: 'T10Y2Y' }], transform: 'none',
    market: true, changeInBp: true, rule: { kind: 'curve' },
    weight: 0, maxAgeDays: 7, note: '負值＝殖利率曲線倒掛，常領先景氣衰退；回測觸發樣本太少，僅供參考不計分',
  },
  // ── 美元／匯率 ─────────────────────────────
  {
    id: 'dxy', name: '美元指數 DXY', short: 'DXY', category: 'fx', frequency: 'daily',
    subtitle: '美元指數｜對主要貨幣',
    unit: 'pt', decimals: 2, sources: [{ provider: 'yahoo', symbol: 'DX-Y.NYB' }], transform: 'none',
    market: true,
    rule: { kind: 'risingIsBearish', lookback: 20, mode: 'pct', bearAt: 1.5, bullAt: -1.5 },
    weight: 0.5, maxAgeDays: 5, note: '美元走強通常伴隨資金撤出新興市場',
  },
  {
    id: 'usdtwd', name: '美元／新台幣', short: 'USD/TWD', category: 'fx', frequency: 'daily',
    subtitle: '美元兌台幣｜升＝台幣貶',
    unit: 'TWD', decimals: 3,
    sources: [{ provider: 'yahoo', symbol: 'TWD=X' }, { provider: 'fred', symbol: 'DEXTAUS' }],
    transform: 'none', market: true,
    rule: { kind: 'risingIsBearish', lookback: 20, mode: 'pct', bearAt: 1.5, bullAt: -1.5 },
    weight: 0.5, maxAgeDays: 10, note: '數值上升＝台幣貶值，常反映外資匯出',
  },
  // 亞洲匯率（跨市場對照面板用；只抓取、不列入指標表與計分）
  // 判斷外資撤出要三角確認：當地股跌＋當地貨幣貶＋DXY 沒同步漲；只有貨幣貶、DXY 也漲＝全球美元回流，不是針對該國
  {
    id: 'usdkrw', name: '美元／韓元', short: 'USD/KRW', category: 'fx', frequency: 'daily',
    subtitle: '美元兌韓元｜升＝韓元貶',
    unit: 'KRW', decimals: 2, sources: [{ provider: 'yahoo', symbol: 'KRW=X' }], transform: 'none',
    market: true, rule: { kind: 'info' }, weight: 0, maxAgeDays: 10, hidden: true,
    note: '數值上升＝韓元貶值；韓元與台幣同為風險貨幣，外資賣韓股換回美元時韓元走貶。跨市場對照面板用，不計分',
  },
  // 日圓是避險貨幣：恐慌時常「升值」（2024-08 套利交易平倉日股大跌、日圓大升），主要受美日利差驅動，不能用來判斷外資撤出日股
  {
    id: 'usdjpy', name: '美元／日圓', short: 'USD/JPY', category: 'fx', frequency: 'daily',
    subtitle: '美元兌日圓｜避險貨幣，看利差',
    unit: 'JPY', decimals: 3, sources: [{ provider: 'yahoo', symbol: 'JPY=X' }], transform: 'none',
    market: true, rule: { kind: 'info' }, weight: 0, maxAgeDays: 10, hidden: true,
    note: '數值上升＝日圓貶值。日圓是避險貨幣，市場恐慌時常升值，主要受美日利差驅動，不適合判斷外資是否撤出日股。跨市場對照面板用，不計分',
  },
  // ── 能源 ──────────────────────────────────
  {
    id: 'wti', name: 'WTI 原油', short: 'WTI', category: 'energy', frequency: 'daily',
    subtitle: '美國原油｜美國油價基準',
    unit: 'USD', decimals: 2,
    sources: [{ provider: 'yahoo', symbol: 'CL=F' }, { provider: 'fred', symbol: 'DCOILWTICO' }],
    transform: 'none', market: true,
    rule: { kind: 'risingIsBearish', lookback: 20, mode: 'pct', bearAt: 15, bullAt: null },
    weight: 0, maxAgeDays: 10, note: '油價急漲推升通膨預期與利率；回測觸發樣本太少，僅供參考不計分',
  },
  {
    id: 'brent', name: 'Brent 原油', short: 'Brent', category: 'energy', frequency: 'daily',
    subtitle: '北海原油｜國際油價基準',
    unit: 'USD', decimals: 2,
    sources: [{ provider: 'yahoo', symbol: 'BZ=F' }, { provider: 'fred', symbol: 'DCOILBRENTEU' }],
    transform: 'none', market: true,
    rule: { kind: 'risingIsBearish', lookback: 20, mode: 'pct', bearAt: 15, bullAt: null },
    weight: 0, maxAgeDays: 10, note: '國際油價基準，與 WTI 互相驗證；僅供參考不計分',
  },
  // ── 原物料／風險（跨市場對照面板用；只抓取、不列入指標表與計分） ──
  // 黃金不是戰爭預測器：金價＝實質利率＋美元＋央行買盤＋避險情緒，地緣事件多為事後反應且常反轉；
  // 用途是分辨「今天是哪種行情」（黃金↑油↑殖利率↓＝地緣避險；黃金↑美元↑殖利率↑＝通膨；黃金↑美元↓＝降息預期）
  {
    id: 'gold', name: '黃金（COMEX 近月期貨）', short: '黃金', category: 'commodity', frequency: 'daily',
    subtitle: '黃金期貨｜避險與實質利率',
    unit: 'USD', decimals: 2, sources: [{ provider: 'yahoo', symbol: 'GC=F' }], transform: 'none',
    market: true, rule: { kind: 'info' }, weight: 0, maxAgeDays: 10, hidden: true,
    note: 'COMEX 黃金近月期貨（美元／盎司）；跨市場對照面板用，不計分',
  },
  // TLT 是美債10Y 殖利率的價格鏡像（存續期間約 16 年：殖利率 +10bp ≈ TLT −1.6%）；Yahoo 即時，比 FRED 的 DGS10 早 1–2 天
  {
    id: 'tlt', name: 'iShares 20 年期以上美債 ETF', short: 'TLT', category: 'rates', frequency: 'daily',
    subtitle: '美債20年ETF｜殖利率升＝價格跌',
    unit: 'USD', decimals: 2, sources: [{ provider: 'yahoo', symbol: 'TLT' }], transform: 'none',
    market: true, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, hidden: true,
    note: '美債價格代理：殖利率升則跌，與 10Y 走勢相關約 0.9；可比 FRED 早 1–2 天看到昨晚美債實際走勢。跨市場對照面板用，不計分',
  },
  {
    id: 'vix', name: 'VIX 恐慌指數', short: 'VIX', category: 'us_equity', frequency: 'daily',
    subtitle: 'S&P500 隱含波動率｜市場為風險付的保費',
    unit: 'pt', decimals: 2, sources: [{ provider: 'yahoo', symbol: '^VIX' }], transform: 'none',
    market: true, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, hidden: true,
    note: 'CBOE 以 S&P 500 選擇權計算的 30 日隱含波動率；比黃金乾淨的風險情緒量尺（不混利率）。跨市場對照面板用，不計分',
  },
  // ── 美國總經 ───────────────────────────────
  {
    id: 'fed', name: 'Fed 政策利率（目標區間）', short: 'Fed利率', category: 'macro', frequency: 'daily',
    subtitle: '聯邦基金利率上緣',
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
  // 2008-12-16 前 FRED 沒有目標區間，只有單一目標利率（DFEDTAR，1982-09～2008-12-15）：
  // 只給「政策利率 vs 通膨」面板拼接長期歷史用，不列入指標表與計分；序列已結束，maxAgeDays 設大避免判過時
  {
    id: 'fed_target_legacy', name: 'Fed 目標利率（2008 年前，單一目標）', short: 'Fed舊目標', category: 'macro', frequency: 'daily',
    unit: '%', decimals: 2, sources: [{ provider: 'fred', symbol: 'DFEDTAR' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 100_000, note: '', hidden: true,
  },
  {
    id: 'cpi', name: 'CPI 年增率', short: 'CPI', category: 'macro', frequency: 'monthly',
    subtitle: '消費者物價｜下游，你買的價',
    unit: '%', decimals: 1, sources: [{ provider: 'fred', symbol: 'CPIAUCNS' }], transform: 'yoy',
    market: false, rule: { kind: 'inflationTrend', lookback: 3, threshold: 0.2 },
    weight: 0.5, maxAgeDays: 75, note: '整體通膨；趨勢下降給 Fed 降息空間（年增率用未季調指數，與 BLS 新聞稿一致）',
  },
  {
    id: 'core_cpi', name: '核心 CPI 年增率', short: '核心CPI', category: 'macro', frequency: 'monthly',
    subtitle: 'CPI 扣食品能源｜Fed 重視',
    unit: '%', decimals: 1, sources: [{ provider: 'fred', symbol: 'CPILFENS' }], transform: 'yoy',
    market: false, rule: { kind: 'inflationTrend', lookback: 3, threshold: 0.2 },
    weight: 1, maxAgeDays: 75, note: '排除食品能源，Fed 更重視的通膨指標（年增率用未季調指數，與 BLS 新聞稿一致）',
  },
  // PPI：回測（2026-10，claude/PPI回測紀錄）顯示對台股 60 日報酬無鑑別力、方向常與通膨邏輯相反 → 參考型不計分；
  // 用途是提前預告 CPI／PCE（PPI 年增 3 月變化與 1–2 個月後核心 PCE 的相關係數約 0.5）
  {
    id: 'ppi', name: 'PPI 最終需求年增率', short: 'PPI', category: 'macro', frequency: 'monthly',
    subtitle: '生產者物價｜上游，出廠價',
    unit: '%', decimals: 1, sources: [{ provider: 'fred', symbol: 'PPIFIS' }], transform: 'yoy',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 75,
    note: '生產者出廠價格，通膨的上游；通常比 CPI 早或同週公布，用來預告 CPI／PCE。回測對台股無預測力，僅供參考不計分（季調指數，與 BLS 未季調年增差距通常 <0.1pp）',
  },
  {
    id: 'core_ppi', name: '核心 PPI 年增率', short: '核心PPI', category: 'macro', frequency: 'monthly',
    subtitle: 'PPI 扣食品能源',
    unit: '%', decimals: 1, sources: [{ provider: 'fred', symbol: 'PPIFES' }], transform: 'yoy',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 75,
    note: '排除食品能源的生產者價格；其中醫療、機票、投資管理費等項目直接進入核心 PCE。僅供參考不計分',
  },
  // PCE 公布比 CPI 晚（8 月數據 10 月底才被 9 月取代）→ maxAgeDays 95（CPI 為 75）
  // PCE：Fed 2% 通膨目標的正式衡量指標（核心 PCE）。公布晚同月 CPI 約 2 週，且大半可由 CPI＋PPI 分項推算，
  // 對台股判多空與核心 CPI 高度重疊（PPI 回測紀錄）→ 參考型不計分；用途是對照 FOMC（距 2% 目標多遠）
  {
    id: 'pce', name: 'PCE 物價年增率', short: 'PCE', category: 'macro', frequency: 'monthly',
    subtitle: '個人消費支出物價｜Fed 的尺',
    unit: '%', decimals: 1, sources: [{ provider: 'fred', symbol: 'PCEPI' }], transform: 'yoy',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 95,
    note: '個人消費支出物價（BEA），權重隨消費行為變動、含代付醫療，通常低於 CPI 0.3–0.5pp；與 GDP 同日公布。僅供參考不計分',
  },
  {
    id: 'core_pce', name: '核心 PCE 年增率', short: '核心PCE', category: 'macro', frequency: 'monthly',
    subtitle: 'PCE 扣食品能源｜Fed 目標',
    unit: '%', decimals: 1, sources: [{ provider: 'fred', symbol: 'PCEPILFE' }], transform: 'yoy',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 95,
    note: 'Fed 2% 通膨目標看的就是這個；比同月 CPI 晚約 2 週公布，大半可由 CPI＋PPI 分項推算，驚喜小。僅供參考不計分',
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
    subtitle: '美國失業率｜Sahm 衰退訊號',
    unit: '%', decimals: 1, sources: [{ provider: 'fred', symbol: 'UNRATE' }], transform: 'none',
    market: false, changeInBp: false, rule: { kind: 'sahm', bullBelow: null },
    weight: 0.5, maxAgeDays: 75, note: 'Sahm 法則：3月均值較前12月低點升 ≥0.5pp 為衰退訊號',
  },
  {
    id: 'nfp', name: '非農就業新增', short: '非農', category: 'macro', frequency: 'monthly',
    subtitle: '非農就業｜每月新增工作數',
    unit: 'k', decimals: 0, sources: [{ provider: 'fred', symbol: 'PAYEMS' }], transform: 'diff',
    market: false, rule: { kind: 'payrolls', bullAt: null, bearAt: 0 },
    weight: 0.5, maxAgeDays: 75, note: '每月新增就業人數（千人）；以 3 個月平均判斷',
  },
  {
    id: 'gdp', name: '美國實質 GDP（年化季增）', short: '實質GDP', category: 'macro', frequency: 'quarterly',
    subtitle: '美國實質 GDP｜年化季增',
    unit: '%', decimals: 1, sources: [{ provider: 'fred', symbol: 'A191RL1Q225SBEA' }], transform: 'none',
    market: false, rule: { kind: 'growth', bullAt: 2, bearAt: 0 },
    weight: 0.5, maxAgeDays: 230, note: 'BEA 公布之實質 GDP 年化季增率（季度結束約 1 個月後初值）',
  },
  {
    id: 'gdpnow', name: 'Atlanta Fed GDPNow', short: 'GDPNow', category: 'macro', frequency: 'quarterly',
    subtitle: '亞特蘭大 Fed 即時預估',
    unit: '%', decimals: 1, sources: [{ provider: 'fred', symbol: 'GDPNOW' }], transform: 'none',
    market: false, rule: { kind: 'growth', bullAt: 2, bearAt: 0 },
    weight: 0.5, maxAgeDays: 200, note: '當季 GDP 即時預估（日期為所預估的季度起始日）',
  },
  // ── 美股 ──────────────────────────────────
  {
    id: 'spx', name: 'S&P 500', short: 'S&P500', category: 'us_equity', frequency: 'daily',
    subtitle: '標普500｜美股大盤',
    unit: 'pt', decimals: 2,
    sources: [{ provider: 'yahoo', symbol: '^GSPC' }, { provider: 'fred', symbol: 'SP500' }],
    transform: 'none', market: true, rule: { kind: 'trend' }, weight: 0.25, maxAgeDays: 5,
    note: '美股大盤風險偏好',
  },
  {
    id: 'nasdaq', name: 'NASDAQ 綜合指數', short: 'NASDAQ', category: 'us_equity', frequency: 'daily',
    subtitle: '那斯達克｜美股科技股',
    unit: 'pt', decimals: 2,
    sources: [{ provider: 'yahoo', symbol: '^IXIC' }, { provider: 'fred', symbol: 'NASDAQCOM' }],
    transform: 'none', market: true, rule: { kind: 'trend' }, weight: 0.25, maxAgeDays: 5,
    note: '科技股風向，與台股電子權值連動高',
  },
  {
    id: 'sox', name: '費城半導體指數', short: '費半SOX', category: 'us_equity', frequency: 'daily',
    subtitle: '費城半導體｜台股電子領先',
    unit: 'pt', decimals: 2, sources: [{ provider: 'yahoo', symbol: '^SOX' }], transform: 'none',
    market: true, rule: { kind: 'trend' }, weight: 0.5, maxAgeDays: 5,
    note: '與台股（半導體權重高）連動最直接',
  },
  // ── 亞股（跨市場對照面板用；只抓取、不列入指標表與計分） ──
  {
    id: 'nikkei', name: '日經 225', short: '日經225', category: 'asia_equity', frequency: 'daily',
    subtitle: '日本股市｜與台股同時段',
    unit: 'pt', decimals: 2, sources: [{ provider: 'yahoo', symbol: '^N225' }], transform: 'none',
    market: true, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, hidden: true,
    note: '與台股同時段交易的亞洲主要市場；跨市場對照面板用，不計分',
  },
  {
    id: 'kospi', name: '韓國 KOSPI', short: 'KOSPI', category: 'asia_equity', frequency: 'daily',
    subtitle: '韓國股市｜半導體、記憶體',
    unit: 'pt', decimals: 2, sources: [{ provider: 'yahoo', symbol: '^KS11' }], transform: 'none',
    market: true, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, hidden: true,
    note: '三星、SK 海力士占比高，產業結構與台股最接近且同時段交易；跨市場對照面板用，不計分',
  },
  // 外資撤出亞洲的直接證據（匯率只是結果）；KRX 官方平台需登入，改用 Naver（資料源自韓國交易所）
  {
    id: 'kr_foreign', name: '韓國外資買賣超（KOSPI）', short: '韓外資', category: 'asia_equity', frequency: 'daily',
    subtitle: '外國人 KOSPI 淨買賣｜億韓元',
    unit: '億', decimals: 0, sources: [{ provider: 'naver_kr', symbol: 'KOSPI_FOREIGN' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, hidden: true, flow: true, chart: 'histogram',
    note: '外國人在韓國 KOSPI 的每日淨買賣（億韓元，Naver Pay 證券；2010 年起）。跨市場對照面板換算成億美元與台灣外資並列，不計分',
  },
  // ── 台股 ──────────────────────────────────
  {
    id: 'taiex', name: '台灣加權指數', short: '加權指數', category: 'tw_equity', frequency: 'daily',
    subtitle: '台灣加權指數｜上市大盤',
    unit: 'pt', decimals: 2,
    sources: [{ provider: 'yahoo', symbol: '^TWII' }, { provider: 'twse', symbol: 'TAIEX' }],
    transform: 'none', market: true, rule: { kind: 'trend' }, weight: 0.5, maxAgeDays: 5,
    note: '台股大盤自身趨勢',
  },
  {
    id: 'tpex', name: '櫃買指數', short: '櫃買指數', category: 'tw_equity', frequency: 'daily',
    subtitle: '櫃買指數｜上櫃中小型股',
    unit: 'pt', decimals: 2, sources: [{ provider: 'tpex', symbol: 'TPEX_INDEX' }], transform: 'none',
    market: true, rule: { kind: 'trend' }, weight: 0.25, maxAgeDays: 5,
    note: '中小型股風險偏好',
  },
  // ── 台股籌碼（僅供參考，權重 0；待回測驗證後再決定是否計分） ──
  {
    id: 'fut_foreign_oi', name: '外資台指期淨未平倉', short: '外資期淨OI', category: 'tw_chips', frequency: 'daily',
    subtitle: '外資台指期淨未平倉口數',
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
    subtitle: '外資台指選擇權淨金額',
    unit: '億', decimals: 2, sources: [{ provider: 'taifex', symbol: 'TXO_FOREIGN_NET' }], transform: 'none',
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, chart: 'line',
    note: '外資 CALL 未平倉金額淨額 − PUT 未平倉金額淨額（億元）；正值偏多、負值偏空。看金額不看口數；週選擇權結算日前後會劇烈跳動',
  },
  {
    id: 'top10_specific_oi', name: '前十大特定法人台指期淨未平倉', short: '十大法人期', category: 'tw_chips', frequency: 'daily',
    subtitle: '十大特定法人台指期淨未平倉',
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
    subtitle: '散戶小台淨未平倉｜法人反推',
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
    subtitle: '融資擔保維持率｜140% 斷頭',
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
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, chart: 'histogram', flow: true, bearish: true,
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
    market: false, rule: { kind: 'info' }, weight: 0, maxAgeDays: 5, hidden: true, bearish: true,
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
    case 'naver_kr':
      return 'https://m.stock.naver.com/domestic/index/KOSPI/total';
  }
}

export const PROVIDER_LABEL: Record<SourceSpec['provider'], string> = {
  yahoo: 'Yahoo Finance',
  fred: 'FRED（St. Louis Fed）',
  tpex: '櫃買中心 TPEx',
  twse: '臺灣證交所 TWSE',
  taifex: '臺灣期交所 TAIFEX',
  twse_chips: '臺灣證交所 TWSE',
  naver_kr: 'Naver Pay 證券（韓國交易所資料）',
};
