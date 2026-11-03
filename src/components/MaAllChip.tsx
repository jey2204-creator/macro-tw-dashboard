import { MA_PERIODS, type MaPeriod } from '../shared/timeseries';

type Props = {
  mas: readonly MaPeriod[];
  onMas: (mas: MaPeriod[]) => void;
};

/**
 * 均線「全部」切換鈕：有任一條開著 → 點了全關；全關 → 點了全開。
 * 全開＝實心、部分開＝半透明（aria-pressed="mixed"）、全關＝空心。
 */
export function MaAllChip({ mas, onMas }: Props) {
  const state: 'all' | 'some' | 'none' = mas.length === 0 ? 'none' : mas.length === MA_PERIODS.length ? 'all' : 'some';
  const pressed = state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false';
  const next = state === 'none' ? '全開' : '全關';
  return (
    <button
      type="button"
      className="ma-chip ma-all"
      aria-pressed={pressed}
      title={`均線${next}（目前 ${mas.length}／${MA_PERIODS.length} 條）`}
      aria-label={`均線${next}`}
      onClick={() => onMas(state === 'none' ? [...MA_PERIODS] : [])}
    >
      全部
    </button>
  );
}
