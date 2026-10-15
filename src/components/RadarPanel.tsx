import { useState } from 'react';
import { basisText, fmtLevel, fmtScore, gapText, moveText, sigmaText } from '../lib/outlookText';
import { radar, regimeGaps, type DailyOutlook } from '../shared/dailyOutlook';
import { INDICATOR_MAP } from '../shared/indicators';
import { SIGNAL_LABEL, type Regime } from '../shared/regime';

/**
 * 翻轉雷達：每日市場指標（美債、美元、台幣、股價趨勢）離翻轉還差多少。
 * 公布日才會變的總經指標見下方「接下來公布」。
 */
export function RadarPanel({
  regime,
  outlooks,
  onSelect,
}: {
  regime: Regime;
  outlooks: Record<string, DailyOutlook>;
  onSelect: (id: string) => void;
}) {
  const [all, setAll] = useState(false);
  const gaps = regimeGaps(regime);
  const r = radar(outlooks);
  const flips = all ? r.flips : r.flips.slice(0, 4);
  const drifts = all ? r.drifts : r.drifts.slice(0, 3);
  const hidden = r.flips.length - flips.length + (r.drifts.length - drifts.length);

  return (
    <section className="radar" aria-label="翻轉雷達">
      <div className="radar-head">
        <span className="label">🎯 翻轉雷達</span>
        <span className="small muted">每日市場指標，下一個收盤就可能變</span>
      </div>

      <ul className="radar-gaps">
        {gaps.map((g) => (
          <li key={g.direction} className={g.weight <= 0.5 ? 'flip' : undefined}>
            <span className={`gap-dir sig-${g.to}`}>{g.direction === 'bear' ? '▼' : '▲'} 距{SIGNAL_LABEL[g.to]}</span>
            <span className="num">{g.gap.toFixed(2)}</span>
            <span className="gap-text">{gapText(g.weight, g.direction)}</span>
          </li>
        ))}
      </ul>

      {flips.length > 0 && (
        <>
          <h3 className="radar-sub">最接近的門檻（依日波動排序）</h3>
          <ol className="radar-list">
            {flips.map(({ id, flip }) => {
              const def = INDICATOR_MAP[id]!;
              const o = outlooks[id]!;
              return (
                <li key={`${id}-${flip.signal}-${flip.dir}`}>
                  <button type="button" className="radar-item" onClick={() => onSelect(id)}>
                    <span className="ri-main">
                      <b>{def.short}</b> {SIGNAL_LABEL[o.current]}→<span className={`sig-${flip.signal} sig-text`}>{SIGNAL_LABEL[flip.signal]}</span>
                      <span className="num">
                        ：{flip.dir === 'down' ? '≤' : '≥'} {fmtLevel(def, flip.at, o.decimals)}
                      </span>
                      <span className="muted">（{moveText(def, flip.dist, flip.pct)}）</span>
                    </span>
                    <span className="ri-sub small">
                      <span className="muted">{basisText(o.basis, o.targetDate)}・{sigmaText(flip.sigmas)}</span>
                      <span className={flip.flipsRegime ? 'flip' : 'muted'}>
                        {flip.flipsRegime && '⚠️ '}總分 {fmtScore(regime.score)} → {fmtScore(flip.impact.score)}（{SIGNAL_LABEL[flip.impact.regime]}）
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </>
      )}

      {drifts.length > 0 && (
        <>
          <h3 className="radar-sub">價格不動也會變（20 日前的基準逐日往前滾）</h3>
          <ul className="radar-list">
            {drifts.map(({ id, drift }) => {
              const def = INDICATOR_MAP[id]!;
              const o = outlooks[id]!;
              return (
                <li key={`${id}-drift`}>
                  <button type="button" className="radar-item" onClick={() => onSelect(id)}>
                    <span className="ri-main">
                      ⏳ <b>{def.short}</b> 若持平在 {fmtLevel(def, o.last, o.decimals)}，約 {drift.steps} 個交易日後（
                      {drift.date.slice(5).replace('-', '/')}）轉<span className={`sig-${drift.signal} sig-text`}>{SIGNAL_LABEL[drift.signal]}</span>
                    </span>
                    <span className={`ri-sub small ${drift.flipsRegime ? 'flip' : 'muted'}`}>
                      {drift.flipsRegime && '⚠️ '}總分 → {fmtScore(drift.impact.score)}（{SIGNAL_LABEL[drift.impact.regime]}）
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="radar-foot small muted">
        {hidden > 0 || all ? (
          <button type="button" className="linkbtn" onClick={() => setAll(!all)}>
            {all ? '收合' : `看全部（還有 ${hidden} 項）`}
          </button>
        ) : null}
        <span>
          σ＝近 60 筆日變化的標準差；單日機率以常態分布估計，實際大波動更常見。只算單一指標，其他指標同時變動時總分會不同。
        </span>
      </div>
    </section>
  );
}
