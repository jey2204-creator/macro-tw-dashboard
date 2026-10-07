import { formatTaipeiDateTime } from '../shared/dates';
import { INDICATORS, PROVIDER_LABEL } from '../shared/indicators';
import type { SummaryFile } from '../shared/types';

const STATUS_SHORT = { ok: '正常', fallback: '備援', cached: '快取', error: '失敗' } as const;

export function SourceStatus({ summary }: { summary: SummaryFile }) {
  const visible = INDICATORS.filter((d) => !d.hidden);
  const counts = visible.reduce<Record<string, number>>((acc, d) => {
    const s = summary.entries[d.id]?.status ?? 'error';
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <details className="sources">
      <summary>
        資料來源與更新狀態
        <span className="muted small">
          正常 {counts.ok ?? 0}・備援 {counts.fallback ?? 0}・快取 {counts.cached ?? 0}・失敗 {counts.error ?? 0}
        </span>
      </summary>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>指標</th>
              <th>來源</th>
              <th>狀態</th>
              <th>最新資料日</th>
              <th>抓取（台北）</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((d) => {
              const e = summary.entries[d.id];
              return (
                <tr key={d.id}>
                  <td>{d.short}</td>
                  <td>
                    {e ? (
                      <a href={e.source.url} target="_blank" rel="noreferrer noopener">
                        {PROVIDER_LABEL[e.source.provider as keyof typeof PROVIDER_LABEL] ?? e.source.provider} {e.source.symbol}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className={e?.status === 'ok' ? '' : 'warn'} title={e?.errors.join('\n')}>
                    {e ? STATUS_SHORT[e.status] : '無資料'}
                  </td>
                  <td className="num">{e?.lastDate ?? '—'}</td>
                  <td className="num">{e ? formatTaipeiDateTime(e.fetchedAt) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        市場資料日期為各交易所當地日期；總經資料日期為所屬期間（例如 CPI 2026-08-01 代表 8 月數據）。
        Yahoo Finance 為非官方介面，台股加權指數已與證交所公布值交叉驗證；殖利率、Fed 利率與總經數據來自 FRED（St. Louis Fed）。
        本頁僅供研究參考，不構成投資建議。
      </p>
    </details>
  );
}
