import { useMemo } from 'react';
import { useSeries } from '../hooks/useData';
import { formatTaipeiDateTime } from '../shared/dates';
import { PROVIDER_LABEL, type IndicatorDef } from '../shared/indicators';
import type { IndicatorEval } from '../shared/regime';
import { MA_PERIODS, type MaPeriod, type Period, type RangeKey } from '../shared/timeseries';
import type { BacktestStats, Bar, SummaryEntry } from '../shared/types';
import { chartBars, MA_COLOR_VAR, type ChartKind } from '../lib/chartData';
import { PriceChart } from './PriceChart';
import { BacktestTable } from './BacktestTable';
import { SignalBadge } from './SignalBadge';

const STATUS_TEXT: Record<SummaryEntry['status'], string> = {
  ok: '正常（主要來源）',
  fallback: '備援來源',
  cached: '來源失敗，顯示上次快取',
  error: '抓取失敗',
};

const PERIODS: { k: Period; label: string }[] = [
  { k: 'D', label: '日K' },
  { k: 'W', label: '週K' },
  { k: 'M', label: '月K' },
];
const RANGES: { k: RangeKey; label: string }[] = [
  { k: '6M', label: '6月' },
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
  { k: 'ALL', label: '全部' },
];

export interface ChartPrefs {
  period: Period;
  range: RangeKey;
  mas: MaPeriod[];
}

interface Props {
  def: IndicatorDef;
  ev: IndicatorEval;
  entry: SummaryEntry | undefined;
  version: string;
  prefs: ChartPrefs;
  onPrefs: (p: ChartPrefs) => void;
  onClose: () => void;
  themeKey: string;
  backtest?: BacktestStats;
  backtestRange?: string;
}

function Seg<T extends string>({ items, value, onChange, label }: { items: { k: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {items.map((it) => (
        <button key={it.k} type="button" aria-pressed={value === it.k} onClick={() => onChange(it.k)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function ChartPanel({ def, ev, entry, version, prefs, onPrefs, onClose, themeKey, backtest, backtestRange }: Props) {
  const series = useSeries(def.id, version);
  const data = series?.status === 'ready' ? series.data : null;
  const { bars, kind } = useMemo(
    () => (data ? chartBars(def, data.data, data.closeOnly, prefs.period) : { bars: [] as Bar[], kind: 'line' as ChartKind }),
    [data, def, prefs.period],
  );
  const toggleMa = (p: MaPeriod) =>
    onPrefs({ ...prefs, mas: prefs.mas.includes(p) ? prefs.mas.filter((x) => x !== p) : [...prefs.mas, p].sort((a, b) => a - b) });
  const mas = def.market ? prefs.mas : [];
  const src = data?.source ?? entry?.source;

  return (
    <section className="chartpanel" aria-label={`${def.name} 圖表`}>
      <header className="cp-head">
        <div className="cp-title">
          <h2>{def.name}</h2>
          <SignalBadge signal={ev.signal.signal} muted={!ev.counted} />
        </div>
        <button type="button" className="iconbtn" onClick={onClose} aria-label="關閉圖表">
          ✕
        </button>
      </header>

      <div className="cp-controls">
        {def.market && <Seg label="K線週期" items={PERIODS} value={prefs.period} onChange={(period) => onPrefs({ ...prefs, period })} />}
        <Seg label="時間區間" items={RANGES} value={prefs.range} onChange={(range) => onPrefs({ ...prefs, range })} />
      </div>
      {def.market && (
        <div className="cp-mas" role="group" aria-label="均線">
          {MA_PERIODS.map((p) => (
            <button key={p} type="button" className="ma-chip" aria-pressed={prefs.mas.includes(p)} onClick={() => toggleMa(p)}>
              <i className="swatch" style={{ background: `var(${MA_COLOR_VAR[p]})` }} />
              MA{p}
            </button>
          ))}
        </div>
      )}

      <div className="cp-chart">
        {series?.status === 'loading' && <div className="cp-msg muted">載入歷史資料中…</div>}
        {series?.status === 'error' && <div className="cp-msg warn">無法載入歷史資料：{series.error}</div>}
        {data && bars.length === 0 && <div className="cp-msg warn">此指標目前沒有資料</div>}
        {data && bars.length > 0 && (
          <PriceChart bars={bars} kind={kind} mas={mas} range={prefs.range} decimals={def.decimals} showPct={def.unit !== '%' && def.unit !== 'k'} themeKey={themeKey} />
        )}
      </div>

      <dl className="cp-info">
        <dt>判斷依據</dt>
        <dd>
          {ev.signal.reason}
          {ev.excludedReason && <span className="warn">（不計分：{ev.excludedReason}）</span>}
        </dd>
        <dt>規則</dt>
        <dd className="muted">{ev.signal.ruleText}</dd>
        {backtest && (
          <>
            <dt>歷史表現</dt>
            <dd>
              <BacktestTable
                caption={`${backtestRange ?? ''} 此規則各狀態之後的加權指數表現`}
                highlight={ev.signal.signal}
                rows={[{ label: '', stats: backtest }]}
              />
            </dd>
          </>
        )}
        <dt>說明</dt>
        <dd className="muted">{def.note}</dd>
        <dt>資料來源</dt>
        <dd>
          {src ? (
            <a href={src.url} target="_blank" rel="noreferrer noopener">
              {PROVIDER_LABEL[src.provider as keyof typeof PROVIDER_LABEL] ?? src.provider}・{src.symbol}
            </a>
          ) : (
            '—'
          )}
          {data?.closeOnly && def.market && <span className="muted">（僅收盤價，以折線呈現）</span>}
        </dd>
        <dt>資料狀態</dt>
        <dd>
          {entry ? STATUS_TEXT[entry.status] : '無資料'}
          {entry?.partial && '・最後一筆為盤中'}
        </dd>
        <dt>最新資料日</dt>
        <dd className="num">
          {entry?.lastDate ?? '—'} <span className="muted">（{def.market ? '市場當地日期' : '資料所屬期間'}）</span>
        </dd>
        <dt>抓取時間</dt>
        <dd className="num">
          {entry ? `${formatTaipeiDateTime(entry.fetchedAt)}（台北）` : '—'}
          {entry?.lastSuccessAt && entry.lastSuccessAt !== entry.fetchedAt && (
            <span className="muted">・上次成功 {formatTaipeiDateTime(entry.lastSuccessAt)}</span>
          )}
        </dd>
        {entry && entry.errors.length > 0 && (
          <>
            <dt>錯誤紀錄</dt>
            <dd className="warn small">{entry.errors.join('；')}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
