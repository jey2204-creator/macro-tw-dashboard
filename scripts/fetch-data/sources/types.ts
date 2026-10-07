import type { Bar } from '../../../src/shared/types';

export interface SourceFetchResult {
  bars: Bar[];
  /** 來源只有收盤價 */
  closeOnly: boolean;
  /** 最後一根為盤中資料 */
  partial: boolean;
  /** true = 只抓了最近一段，需與快取合併 */
  incremental: boolean;
}
