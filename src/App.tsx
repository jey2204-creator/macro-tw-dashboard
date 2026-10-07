import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ChartPanel, type ChartPrefs } from './components/ChartPanel';
import { IndicatorTable } from './components/IndicatorTable';
import { RegimePanel } from './components/RegimePanel';
import { SourceStatus } from './components/SourceStatus';
import { useBacktest, useSummary } from './hooks/useData';
import { buildRow } from './lib/rows';
import { loadList, loadPref, savePref } from './lib/storage';
import { formatTaipeiDateTime, todayInTaipei } from './shared/dates';
import { INDICATOR_MAP } from './shared/indicators';
import { computeRegime } from './shared/regime';
import { MA_PERIODS, type MaPeriod, type Period, type RangeKey } from './shared/timeseries';

const WIDE_QUERY = '(min-width: 1100px)';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

type UpDown = 'tw' | 'us';
type Theme = 'auto' | 'light' | 'dark';

export default function App() {
  const [reloadKey, setReloadKey] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const reload = () => {
    setReloadKey((k) => k + 1);
    setNowMs(Date.now());
  };
  const summaryState = useSummary(reloadKey);
  const isWide = useMedia(WIDE_QUERY);
  const systemDark = useMedia(DARK_QUERY);

  const [upDown, setUpDown] = useState<UpDown>(() => loadPref('updown', ['tw', 'us'] as const, 'tw'));
  const [theme, setTheme] = useState<Theme>(() => loadPref('theme', ['auto', 'light', 'dark'] as const, 'auto'));
  const [prefs, setPrefs] = useState<ChartPrefs>(() => ({
    period: loadPref<Period>('period', ['D', 'W', 'M'], 'D'),
    range: loadPref<RangeKey>('range', ['6M', '1Y', '5Y', 'ALL'], '1Y'),
    mas: loadList('mas', [20, 60, 240]).filter((p): p is MaPeriod => (MA_PERIODS as readonly number[]).includes(p)),
  }));
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.updown = upDown;
    savePref('updown', upDown);
  }, [upDown]);
  useEffect(() => {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    savePref('theme', theme);
  }, [theme]);

  const onPrefs = useCallback((p: ChartPrefs) => {
    setPrefs(p);
    savePref('period', p.period);
    savePref('range', p.range);
    savePref('mas', JSON.stringify(p.mas));
  }, []);

  const today = todayInTaipei(new Date(nowMs));
  const summary = summaryState.status === 'ready' ? summaryState.data : null;
  const backtest = useBacktest(summary?.generatedAt ?? null);
  const regime = useMemo(() => (summary ? computeRegime(summary, today) : null), [summary, today]);
  const rows = useMemo(() => (regime && summary ? regime.evals.map((ev) => buildRow(ev, summary)) : []), [regime, summary]);

  // 桌面版預設顯示加權指數圖表
  const activeId = selected ?? (isWide ? 'taiex' : null);
  const activeDef = activeId ? INDICATOR_MAP[activeId] : undefined;
  const activeEval = regime?.evals.find((e) => e.def.id === activeId);
  const overlay = !isWide && !!activeId;

  useEffect(() => {
    if (!overlay) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelected(null);
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [overlay]);

  const themeKey = `${theme}-${systemDark}-${upDown}`;
  const dataAgeHours = summary ? (nowMs - Date.parse(summary.generatedAt)) / 3_600_000 : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>美國總經 → 台股儀表板</h1>
          {summary && (
            <span className={`small num ${dataAgeHours > 36 ? 'warn' : 'muted'}`}>
              資料更新 {formatTaipeiDateTime(summary.generatedAt)}
              {dataAgeHours > 36 && '（超過 36 小時未更新）'}
            </span>
          )}
        </div>
        <div className="tools">
          <button
            type="button"
            className="toolbtn"
            onClick={() => setUpDown(upDown === 'tw' ? 'us' : 'tw')}
            title="切換漲跌顏色慣例"
          >
            {upDown === 'tw' ? <><span className="up">紅漲</span><span className="down">綠跌</span></> : <><span className="up">綠漲</span><span className="down">紅跌</span></>}
          </button>
          <button
            type="button"
            className="toolbtn"
            onClick={() => setTheme(theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto')}
            title="切換主題"
          >
            {theme === 'auto' ? '自動' : theme === 'dark' ? '深色' : '淺色'}
          </button>
          <button type="button" className="toolbtn" onClick={reload} title="重新載入資料">
            ↻
          </button>
        </div>
      </header>

      {summaryState.status === 'loading' && <p className="pad muted">載入中…</p>}
      {summaryState.status === 'error' && (
        <div className="pad warn">
          無法載入資料（{summaryState.error}）。可能是資料尚未產生或網路問題。
          <button type="button" className="linkbtn" onClick={reload}>
            重試
          </button>
        </div>
      )}

      {summary && regime && (
        <main className={`layout${isWide ? ' wide' : ''}`}>
          <div className="col-main">
            <RegimePanel regime={regime} onSelect={setSelected} backtest={backtest} />
            <IndicatorTable rows={rows} today={today} selectedId={activeId} onSelect={setSelected} />
            <SourceStatus summary={summary} />
          </div>
          {activeDef && activeEval && (
            <aside className={overlay ? 'overlay' : 'col-chart'}>
              <ChartPanel
                key={activeDef.id}
                def={activeDef}
                ev={activeEval}
                entry={summary.entries[activeDef.id]}
                version={summary.generatedAt}
                prefs={prefs}
                onPrefs={onPrefs}
                onClose={() => setSelected(isWide ? 'taiex' : null)}
                themeKey={themeKey}
                backtest={backtest?.indicators[activeDef.id]}
                backtestRange={backtest ? `${backtest.start}～${backtest.end}` : undefined}
              />
            </aside>
          )}
        </main>
      )}
    </div>
  );
}
