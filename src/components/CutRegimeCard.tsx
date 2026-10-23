import { useState } from 'react';
import { pctCell } from '../lib/stressFormat';
import {
  CREDIT_RECESSION_PP,
  CREDIT_WATCH_PP,
  HY_RECESSION_BP,
  HY_WATCH_BP,
  INFLATION_HOT_PP,
  LEVEL_COLOR,
  LEVEL_TEXT,
  SAHM_WATCH,
  VERDICT_COLOR,
  VERDICT_SHORT,
  VERDICT_TEXT,
  type CutAssessment,
  type Readings,
  type VerdictStat,
} from '../shared/cutRegime';
import { PHASE_TEXT, SAHM_TRIGGER, type FedPhase } from '../shared/fedEquity';

const ym = (d: string | null) => (d ? d.slice(0, 7) : '—');
const fpp = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}pp`);
const fbp = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v}bp`);

function Lamp({ color }: { color: string }) {
  return <i className="lamp" style={{ background: `var(${color})` }} aria-hidden="true" />;
}

interface Props {
  now: Readings;
  phase: FedPhase | null;
  rows: CutAssessment[];
  stats: VerdictStat[];
  /** 有加權資料（1997 起）才顯示加權欄 */
  hasTaiex: boolean;
}

/**
 * 降息性質判定：目前讀數（就業、信用、通膨三訊號）＋歷次第一次降息「當時判定 vs 事後結果」。
 * 放在政策利率面板的圖與 Fed 階段表之間；參考、不計分。
 */
export function CutRegimeCard({ now, phase, rows, stats, hasTaiex }: Props) {
  const [open, setOpen] = useState(false);
  const cutting = phase === 'cut';
  const lead = cutting ? '這次降息依目前讀數是' : '若接下來降息，依目前讀數會是';
  return (
    <div className="cr" aria-label="降息性質判定">
      <p className="score num cr-verdict">
        <span className="muted small">{phase ? `Fed 階段：${PHASE_TEXT[phase]}｜` : ''}{lead}</span>{' '}
        <Lamp color={VERDICT_COLOR[now.verdict]} />
        <b>{VERDICT_TEXT[now.verdict]}</b>
        {now.inflationHot && <span className="warn">｜通膨未解（核心CPI 距 2% {fpp(now.coreGap)}）→ 停滯型風險</span>}
      </p>
      <div className="table-wrap">
        <table className="bt-table num cr-table">
          <thead>
            <tr>
              <th>訊號（門檻）</th>
              <th className="r">讀數</th>
              <th>判定</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                就業 <span className="muted small">Sahm 值 {ym(now.sahmDate)}</span>
                <br />
                <span className="muted small">≥ {SAHM_TRIGGER} 衰退、≥ {SAHM_WATCH} 警戒</span>
              </td>
              <td className="r">{now.sahm === null ? '—' : `${now.sahm.toFixed(2)}pp`}</td>
              <td className="nw">
                <Lamp color={LEVEL_COLOR[now.sahmLevel]} />
                {LEVEL_TEXT[now.sahmLevel]}
              </td>
            </tr>
            <tr>
              <td>
                信用 <span className="muted small">Baa−10Y {now.creditDate ?? '—'}</span>
                <br />
                <span className="muted small">≥ {CREDIT_RECESSION_PP} 衰退、≥ {CREDIT_WATCH_PP} 警戒</span>
              </td>
              <td className="r">
                {now.credit === null ? '—' : `${now.credit.toFixed(2)}pp`}
                {now.creditChg60 !== null && (
                  <>
                    <br />
                    <span className="muted small">60日 {fpp(now.creditChg60)}</span>
                  </>
                )}
              </td>
              <td className="nw">
                <Lamp color={LEVEL_COLOR[now.creditLevel]} />
                {LEVEL_TEXT[now.creditLevel]}
              </td>
            </tr>
            {now.hy !== null && (
              <tr>
                <td>
                  <span className="muted small">↳ HY 利差 {now.hyDate}（FRED 只給近 3 年，只顯示）</span>
                  <br />
                  <span className="muted small">≥ {HY_RECESSION_BP} 衰退、≥ {HY_WATCH_BP} 警戒</span>
                </td>
                <td className="r muted">{now.hy}bp</td>
                <td className="nw muted">
                  <Lamp color={LEVEL_COLOR[now.hyLevel]} />
                  {LEVEL_TEXT[now.hyLevel]}
                </td>
              </tr>
            )}
            <tr>
              <td>
                通膨 <span className="muted small">核心CPI − 2% {ym(now.coreDate)}</span>
                <br />
                <span className="muted small">&gt; {INFLATION_HOT_PP}pp 降息＝停滯型風險</span>
              </td>
              <td className="r">{fpp(now.coreGap)}</td>
              <td className="nw">
                <Lamp color={now.inflationHot ? '--lamp-yellowred' : '--lamp-blue'} />
                {now.inflationHot ? '未解' : '可降'}
              </td>
            </tr>
            <tr>
              <td>
                節奏 <span className="muted small">90 天累計降息</span>
                <br />
                <span className="muted small">{now.lastMoveDate ? `上次動作 ${now.lastMoveDate} ${fbp(now.lastMoveBp)}` : '—'}</span>
              </td>
              <td className="r">{now.paceBp === 0 ? '0bp' : `${now.paceBp}bp`}</td>
              <td className="muted small">兩碼起跳或 90 天 ≥ 100bp 多為衰退式（只顯示）</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="table-wrap">
        <table className="bt-table num">
          <caption className="small muted">
            歷次循環第一次降息：以「降息當天看得到的資料」判定（月資料加 45 天公布延遲），對照事後結果與之後 12 個月報酬（S&P 12 個月內最大跌幅）
          </caption>
          <thead>
            <tr>
              <th>當時判定</th>
              <th className="r">次數</th>
              <th className="r">事後衰退</th>
              <th className="r">S&P 12月</th>
              {hasTaiex && <th className="r">加權 12月</th>}
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.verdict} className={s.verdict === now.verdict ? 'hl' : ''}>
                <td className="nw">
                  <Lamp color={VERDICT_COLOR[s.verdict]} />
                  {VERDICT_SHORT[s.verdict]}
                </td>
                <td className="r">{s.n}</td>
                <td className="r">{s.known ? `${s.recessions}/${s.known}` : '—'}</td>
                <td className="r">
                  {pctCell(s.avgSpx12m)}
                  <br />
                  <span className="small muted">{pctCell(s.avgSpxDrawdown)}</span>
                </td>
                {hasTaiex && (
                  <td className="r">
                    {pctCell(s.avgTaiex12m)}
                    {s.taiexN > 0 && <span className="small muted">・{s.taiexN}</span>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="linkbtn small" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '收起' : '展開'}歷次第一次降息・當時判定（{rows.length}）
      </button>
      {open && (
        <div className="table-wrap">
          <table className="bt-table num">
            <thead>
              <tr>
                <th>日期</th>
                <th>當時判定</th>
                <th className="r">Sahm</th>
                <th className="r">Baa−10Y</th>
                <th className="r">核心−2%</th>
                <th>事後</th>
                <th className="r">S&P 12月</th>
                {hasTaiex && <th className="r">加權 12月</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.event.date}>
                  <td className="nw">
                    {r.event.date}
                    <br />
                    <span className="small muted">{r.event.bp}bp</span>
                  </td>
                  <td className="nw">
                    <Lamp color={VERDICT_COLOR[r.at.verdict]} />
                    {VERDICT_SHORT[r.at.verdict]}
                    {r.at.inflationHot && (
                      <>
                        <br />
                        <span className="warn small">通膨未解</span>
                      </>
                    )}
                    {r.worst && (
                      <>
                        <br />
                        <span className="small muted">{ym(r.worst.date)} 轉{VERDICT_SHORT[r.worst.verdict]}</span>
                      </>
                    )}
                  </td>
                  <td className="r">{r.at.sahm === null ? '—' : r.at.sahm.toFixed(2)}</td>
                  <td className="r">{r.at.credit === null ? '—' : r.at.credit.toFixed(2)}</td>
                  <td className="r">{fpp(r.at.coreGap)}</td>
                  <td>{r.recession === null ? '未滿 12 月' : r.recession ? <span className="warn">衰退</span> : <span className="muted">無</span>}</td>
                  <td className="r">
                    {pctCell(r.event.ret12m)}
                    <br />
                    <span className="small muted">{pctCell(r.event.maxDrawdown)}</span>
                  </td>
                  {hasTaiex && <td className="r">{pctCell(r.taiex12m)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
