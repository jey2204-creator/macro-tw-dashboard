import { CANDLE_RANGES, type IndexStyle } from '../lib/candleStyle';
import type { RangeKey } from '../shared/timeseries';

/** 區間列最右的「K線」開關：亮起＝K 線、再按一次回折線；5 年以上變灰（自動用折線） */
export function KLineButton({ style, setStyle, range, what = '指數' }: { style: IndexStyle; setStyle: (v: IndexStyle) => void; range: RangeKey; what?: string }) {
  const allowed = CANDLE_RANGES.includes(range);
  return (
    <button
      type="button"
      className="fc-kbtn"
      aria-pressed={allowed && style === 'candle'}
      disabled={!allowed}
      onClick={() => setStyle(style === 'candle' ? 'line' : 'candle')}
      title={allowed ? `${what}切換 K 線／折線` : 'K 線只在 3個月／半年／1年畫，5 年以上用折線'}
    >
      K線
    </button>
  );
}

/** 「↺ 重設」：有 K線 開關時，窄手機只留 ↺ */
export function ResetLabel({ compact }: { compact: boolean }) {
  return (
    <>
      ↺<span className={compact ? 'fc-reset-txt' : undefined}> 重設</span>
    </>
  );
}
