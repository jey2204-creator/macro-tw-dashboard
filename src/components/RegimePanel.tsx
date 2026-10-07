import { useState } from 'react';
import { CATEGORY_LABEL } from '../shared/indicators';
import { MIN_COVERAGE, REGIME_THRESHOLD, SIGNAL_LABEL, type Regime } from '../shared/regime';
import { bucketText, bullBearSpread } from '../lib/backtest';
import type { BacktestFile } from '../shared/types';
import { BacktestTable } from './BacktestTable';
import { SignalBadge } from './SignalBadge';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const signed = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
const fmtSpread = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`);

export function RegimePanel({
  regime,
  onSelect,
  backtest,
}: {
  regime: Regime;
  onSelect: (id: string) => void;
  backtest: BacktestFile | null;
}) {
  const years = backtest ? `${backtest.start.slice(0, 4)}–${backtest.end.slice(0, 4)}` : '';
  const [open, setOpen] = useState(false);
  const pos = ((regime.score + 1) / 2) * 100;
  return (
    <section className="regime" aria-label="目前市場環境">
      <div className="regime-head">
        <div className="regime-title">
          <span className="label">目前市場環境</span>
          <span className={`verdict verdict-${regime.signal}`}>{SIGNAL_LABEL[regime.signal]}</span>
          <span className="score num">{signed(regime.score)}</span>
        </div>
        <div className="regime-meta">
          <span className="c-bull">偏多 {regime.bullCount}</span>
          <span className="c-neutral">中性 {regime.neutralCount}</span>
          <span className="c-bear">偏空 {regime.bearCount}</span>
          <span className={regime.lowCoverage ? 'warn' : 'muted'}>涵蓋 {pct(regime.coverage)}</span>
        </div>
      </div>

      <div className="scorebar" role="img" aria-label={`綜合分數 ${signed(regime.score)}，範圍 −1 到 +1`}>
        <div className="zone zone-bear" style={{ width: `${((1 - REGIME_THRESHOLD) / 2) * 100}%` }} />
        <div className="zone zone-neutral" style={{ width: `${REGIME_THRESHOLD * 100}%` }} />
        <div className="zone zone-bull" style={{ width: `${((1 - REGIME_THRESHOLD) / 2) * 100}%` }} />
        <div className="marker" style={{ left: `${Math.min(100, Math.max(0, pos))}%` }} />
      </div>
      <div className="scorebar-axis muted">
        <span>−1 偏空</span>
        <span>−{REGIME_THRESHOLD}</span>
        <span>+{REGIME_THRESHOLD}</span>
        <span>偏多 +1</span>
      </div>

      {backtest && (
        <p className="history small">
          📊 歷史上（{years}）同樣判「{SIGNAL_LABEL[regime.signal]}」時：{bucketText(backtest.composite.full[regime.signal])}
          <span className="muted">（全期基準 {bucketText(backtest.composite.full.all)}）</span>
        </p>
      )}

      {regime.lowCoverage && (
        <p className="warn small">⚠ 可計分指標權重僅 {pct(regime.coverage)}（低於 {pct(MIN_COVERAGE)}），結論僅供參考。</p>
      )}

      <div className="cats">
        {regime.categories.map((c) => (
          <div key={c.category} className="cat">
            <span className="cat-name">{CATEGORY_LABEL[c.category]}</span>
            {c.weight === 0 && regime.evals.every((e) => e.def.category !== c.category || e.def.weight === 0) ? (
              <span className="muted">不計分</span>
            ) : c.signal ? (
              <>
                <SignalBadge signal={c.signal} />
                <span className="num muted">{signed(c.score!)}</span>
              </>
            ) : (
              <span className="muted">無資料</span>
            )}
          </div>
        ))}
      </div>

      <button type="button" className="linkbtn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? '▾ 收合判斷依據' : '▸ 查看判斷依據（每個指標的規則與貢獻）'}
      </button>

      {open && (
        <div className="basis">
          <p className="small muted">
            方法：每個指標依固定規則判為 偏多(+1)／中性(0)／偏空(−1)，乘上權重後加權平均，得到 −1～+1 的分數；
            ≥ +{REGIME_THRESHOLD} 為偏多、≤ −{REGIME_THRESHOLD} 為偏空。資料過時或抓取失敗的指標不計分。
            規則與權重定義在 <code>src/shared/indicators.ts</code>，不含任何 AI 推測。
            「多空差」＝ 歷史上該指標判偏多與判偏空之後 60 日加權報酬的差距，用來檢查規則是否有鑑別力。
            回測已加入公布延遲以避免前視偏誤；但 FRED 為修正後數值，且 60 日觀察期互相重疊，實際獨立樣本有限。
          </p>
          {backtest && (
            <BacktestTable
              caption={`綜合判斷回測（加權指數交易日 ${backtest.start}～${backtest.end}，以目前規則逐日重算；分前後段檢查穩定性）`}
              highlight={regime.signal}
              rows={[
                { label: `全期`, stats: backtest.composite.full },
                { label: `前段 ~${backtest.splitDate.slice(0, 4)}`, stats: backtest.composite.early },
                { label: `後段 ${backtest.splitDate.slice(0, 4)}~`, stats: backtest.composite.late },
              ]}
            />
          )}
          <div className="table-wrap">
            <table className="basis-table">
              <thead>
                <tr>
                  <th>指標</th>
                  <th>判斷</th>
                  <th>依據</th>
                  <th className="r">權重</th>
                  <th className="r">貢獻</th>
                  {backtest && (
                    <th className="r" title="歷史上此指標判偏多時，之後 60 日加權報酬減去判偏空時（百分點）；越大代表越有鑑別力">
                      多空差
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {regime.evals.map((e) => (
                  <tr key={e.def.id} className={e.counted ? '' : 'excluded'} onClick={() => onSelect(e.def.id)}>
                    <td>{e.def.short}</td>
                    <td>
                      <SignalBadge signal={e.signal.signal} muted={!e.counted} />
                    </td>
                    <td>
                      <div>{e.signal.reason}</div>
                      <div className="rule muted">
                        {e.excludedReason ? `【不計分：${e.excludedReason}】` : ''}規則：{e.signal.ruleText}
                      </div>
                    </td>
                    <td className="r num">{e.def.weight}</td>
                    <td className="r num">{e.counted ? signed(e.contribution) : '—'}</td>
                    {backtest && <td className="r num">{fmtSpread(bullBearSpread(backtest.indicators[e.def.id]))}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
