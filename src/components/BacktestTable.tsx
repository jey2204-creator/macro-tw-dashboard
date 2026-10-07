import { SIGNAL_LABEL } from '../shared/regime';
import type { BacktestBucket, BacktestStats } from '../shared/types';

import { pct } from '../lib/backtest';

/** 各訊號狀態的歷史表現；highlight = 目前狀態 */
export function BacktestTable({
  rows,
  highlight,
  caption,
}: {
  rows: { label: string; stats: BacktestStats & { all?: BacktestBucket } }[];
  highlight?: keyof BacktestStats;
  caption?: string;
}) {
  const keys = ['bull', 'neutral', 'bear'] as const;
  return (
    <div className="table-wrap">
      <table className="bt-table num">
        {caption && <caption className="small muted">{caption}</caption>}
        <thead>
          <tr>
            {rows.length > 1 && <th>期間</th>}
            <th>判斷</th>
            <th className="r">時間占比</th>
            <th className="r">60日平均</th>
            <th className="r">上漲機率</th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((r) =>
            [...keys, ...(r.stats.all ? (['all'] as const) : [])].map((k, i) => {
              const b = (r.stats as Record<string, BacktestBucket>)[k]!;
              return (
                <tr key={`${r.label}-${k}`} className={k === highlight ? 'hl' : k === 'all' ? 'all' : ''}>
                  {rows.length > 1 && <td>{i === 0 ? r.label : ''}</td>}
                  <td>{k === 'all' ? '全部（基準）' : SIGNAL_LABEL[k]}</td>
                  <td className="r">{b.days ? `${b.pct.toFixed(0)}%` : '—'}</td>
                  <td className="r">{pct(b.avg60, true)}</td>
                  <td className="r">{pct(b.win60)}</td>
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
    </div>
  );
}
