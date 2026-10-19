import { useMemo } from 'react';
import { useSeries } from '../hooks/useData';
import { formatTaipeiDateTime } from '../shared/dates';
import { coloredZones, PROVIDER_LABEL, toneClass, type IndicatorDef } from '../shared/indicators';
import type { IndicatorEval } from '../shared/regime';
import { closes, MA_PERIODS, type MaPeriod, type Period, type RangeKey } from '../shared/timeseries';
import type { BacktestStats, Bar, SummaryEntry } from '../shared/types';
import { chartBars, MA_COLOR_VAR, type ChartKind } from '../lib/chartData';
import { PriceChart } from './PriceChart';
import { BacktestTable } from './BacktestTable';
import { monthlyCloses, shortMonth, zoneStreaks, type Companion, type ZoneStreak } from '../lib/companion';
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
  { k: '3M', label: '3個月' },
  { k: '6M', label: '半年' },
  { k: '1Y', label: '1年' },
  { k: '5Y', label: '5年' },
  { k: '10Y', label: '10年' },
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

  // 對照窗格（景氣燈號 vs 加權指數）：日資料轉月底收盤，與燈號的資料月份對齊
  const compSeries = useSeries(def.companion?.id ?? null, version);
  const compData = compSeries?.status === 'ready' ? compSeries.data : null;
  const companion = useMemo<Companion | undefined>(
    () => (def.companion && compData ? { label: def.companion.label, ...monthlyCloses(compData.data) } : undefined),
    [def.companion, compData],
  );
  const zones = coloredZones(def);
  const streaks = useMemo(
    () => (companion && zones ? zoneStreaks(closes(bars), zones, closes(companion.bars)).slice(0, 8) : []),
    [companion, zones, bars],
  );

  return (
    <section className="chartpanel" aria-label={`${def.name} 圖表`}>
      <header className="cp-head">
        <div className="cp-title">
          <h2>{def.name}</h2>
          <SignalBadge signal={ev.signal.signal} muted={!ev.counted} info={def.rule.kind === 'info'} />
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
        <div className="cp-mas ma-row" role="group" aria-label="均線">
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
          <PriceChart
            bars={bars}
            kind={kind}
            mas={mas}
            range={prefs.range}
            decimals={def.decimals}
            showPct={!['%', 'pp', 'k', '分'].includes(def.unit)}
            themeKey={themeKey}
            refLines={def.refLines}
            bearish={def.bearish}
            zones={zones}
            companion={companion}
            mainLabel={def.short}
          />
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
        {streaks.length > 0 && companion && (
          <>
            <dt>燈號期間</dt>
            <dd>
              <ZoneStreakTable streaks={streaks} label={companion.label} />
            </dd>
          </>
        )}
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

/** 每段燈號期間（資料月份）加權指數的漲跌；最上面是燈號還沒公布、加權已經走完的月份 */
function ZoneStreakTable({ streaks, label }: { streaks: ZoneStreak[]; label: string }) {
  return (
    <div className="table-wrap">
      <table className="bt-table streak-table num">
        <caption className="small muted">
          期間＝燈號的資料月份。燈號約晚 4 週公布（例：8 月紅燈 9/29 才知道），所以表內的漲跌在當時還看不到。
        </caption>
        <thead>
          <tr>
            <th>燈號</th>
            <th>期間</th>
            <th className="r">月數</th>
            <th className="r">{label}</th>
          </tr>
        </thead>
        <tbody>
          {streaks.map((s) => (
            <tr key={s.from} className={s.zone ? '' : 'all'}>
              <td>
                {s.zone?.color && <i className="lamp" style={{ background: `var(${s.zone.color})` }} aria-hidden="true" />}
                {s.zone ? s.zone.label : '未公布'}
              </td>
              <td>{s.months > 1 ? `${shortMonth(s.from)}–${shortMonth(s.to)}` : shortMonth(s.from)}</td>
              <td className="r">{s.months}</td>
              <td className={`r ${s.change === null ? '' : toneClass({}, s.change > 0 ? 'up' : s.change < 0 ? 'down' : '')}`}>
                {s.change === null ? '—' : `${s.change > 0 ? '+' : ''}${s.change.toFixed(1)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
