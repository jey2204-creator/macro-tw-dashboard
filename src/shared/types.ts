/**
 * 共用型別：前端 UI 與資料抓取腳本（scripts/fetch-data）都使用這份定義。
 * 日期一律以「該市場當地日期」的 YYYY-MM-DD 字串儲存，避免時區造成日期錯位。
 */

/** [日期, 開, 高, 低, 收]；只有收盤價的來源會以 o=h=l=c 填入 */
export type Bar = [date: string, open: number, high: number, low: number, close: number];

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'quarterly';

export type Category = 'rates' | 'fx' | 'energy' | 'macro' | 'us_equity' | 'tw_equity';

export type Signal = 'bull' | 'neutral' | 'bear';

/** 每個指標資料檔的狀態 */
export type SeriesStatus =
  | 'ok' // 主要來源成功
  | 'fallback' // 主要來源失敗，改用備援來源
  | 'cached' // 所有來源失敗，沿用上次成功快取
  | 'error'; // 所有來源失敗且無快取

export interface SourceRef {
  /** 來源代號，例如 yahoo / fred / tpex / twse */
  provider: string;
  /** 來源上的代碼，例如 ^SOX、DGS10 */
  symbol: string;
  /** 人類可讀的來源頁面 */
  url: string;
}

/** public/data/series/<id>.json */
export interface SeriesFile {
  id: string;
  /** 本次資料實際使用的來源 */
  source: SourceRef;
  status: SeriesStatus;
  /** 抓取時間（ISO 8601, UTC） */
  fetchedAt: string;
  /** 最後一次成功更新的時間（ISO 8601, UTC） */
  lastSuccessAt: string | null;
  /** 最新一筆資料日期（市場當地日期） */
  lastDate: string | null;
  /** 是否只有收盤價（無 OHLC） */
  closeOnly: boolean;
  /** 最後一根 K 棒是否為盤中未收盤資料 */
  partial: boolean;
  /** 錯誤訊息（含各來源失敗原因） */
  errors: string[];
  data: Bar[];
}

/** public/data/summary.json 中每個指標的精簡資料 */
export interface SummaryEntry {
  id: string;
  source: SourceRef;
  status: SeriesStatus;
  fetchedAt: string;
  lastSuccessAt: string | null;
  lastDate: string | null;
  closeOnly: boolean;
  partial: boolean;
  errors: string[];
  /** 尾段資料：[日期, 收盤]，長度足以計算 MA240 與年增率 */
  tail: [string, number][];
}

export interface SummaryFile {
  schemaVersion: 1;
  generatedAt: string;
  entries: Record<string, SummaryEntry>;
}

export interface BacktestBucket {
  /** 該狀態占樣本天數比例（%） */
  pct: number;
  days: number;
  /** 之後 20／60 個交易日加權指數平均報酬（%） */
  avg20: number | null;
  avg60: number | null;
  /** 之後 60 個交易日上漲機率（%） */
  win60: number | null;
}

export type BacktestStats = Record<'bull' | 'neutral' | 'bear', BacktestBucket>;

/** public/data/backtest.json：以「目前規則」逐日重算歷史訊號的結果 */
export interface BacktestFile {
  schemaVersion: 1;
  generatedAt: string;
  /** 樣本期間（加權指數交易日） */
  start: string;
  end: string;
  /** 用來檢查穩定性的分段點 */
  splitDate: string;
  indicators: Record<string, BacktestStats>;
  composite: {
    full: BacktestStats & { all: BacktestBucket };
    early: BacktestStats & { all: BacktestBucket };
    late: BacktestStats & { all: BacktestBucket };
  };
}
