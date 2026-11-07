import type { IChartApi, ISeriesApi, IRange, MouseEventParams, SeriesType, Time } from 'lightweight-charts';

/** 同一面板內多張圖的同步：拖曳／縮放（以日期對齊）與十字線 */
export type SyncMember = {
  chart: IChartApi;
  /** 十字線要貼的序列（主圖） */
  series: () => ISeriesApi<SeriesType> | null;
  /** 某日在主圖序列上的值；該市場當天沒資料時回傳 null */
  valueAt: (time: string) => number | null;
  /** 被同步時通知（更新圖例讀數）；setCrosshairPosition 不保證觸發對方的 crosshairMove */
  onSyncedTime?: (time: string | null) => void;
};

export class ChartSync {
  private members = new Map<string, SyncMember>();
  private busy = false;

  add(key: string, m: SyncMember): () => void {
    this.members.set(key, m);
    const onRange = (r: IRange<Time> | null) => {
      if (this.busy || !r) return;
      this.busy = true;
      try {
        for (const [k, o] of this.members) {
          if (k === key) continue;
          try {
            o.chart.timeScale().setVisibleRange(r);
          } catch {
            /* 對方尚無資料 */
          }
        }
      } finally {
        this.busy = false;
      }
    };
    const onCross = (p: MouseEventParams<Time>) => {
      if (this.busy) return;
      this.busy = true;
      try {
        const t = typeof p.time === 'string' ? p.time : null;
        for (const [k, o] of this.members) {
          if (k === key) continue;
          const s = o.series();
          const v = t ? o.valueAt(t) : null;
          if (t && s && v != null) o.chart.setCrosshairPosition(v, t as Time, s);
          else o.chart.clearCrosshairPosition();
          o.onSyncedTime?.(t && v != null ? t : null);
        }
      } finally {
        this.busy = false;
      }
    };
    m.chart.timeScale().subscribeVisibleTimeRangeChange(onRange);
    m.chart.subscribeCrosshairMove(onCross);
    return () => {
      m.chart.timeScale().unsubscribeVisibleTimeRangeChange(onRange);
      m.chart.unsubscribeCrosshairMove(onCross);
      if (this.members.get(key) === m) this.members.delete(key);
    };
  }
}
