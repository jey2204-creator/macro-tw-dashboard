import { useState } from 'react';
import { pctCell } from '../lib/stressFormat';
import { REAL_RATE_TIGHT } from '../shared/policyInflation';
import {
  BET_COLOR,
  BET_TEXT,
  LEAN_COLOR,
  LEAN_TEXT,
  OKUN,
  SPREAD_BAND,
  TAYLOR_BAND,
  TAYLOR_R_STAR,
  stanceHeadline,
  type Stance,
  type StanceStat,
} from '../shared/fedStance';

const ym = (d: string | null) => (d ? d.slice(0, 7) : '—');
const fpp = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}pp`);
const f2 = (v: number | null) => (v === null ? '—' : v.toFixed(2));
const f1 = (v: number | null) => (v === null ? '—' : v.toFixed(1));
const pct0 = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`);

function Lamp({ color }: { color: string }) {
  return <i className="lamp" style={{ background: `var(${color})` }} aria-hidden="true" />;
}

interface Props {
  now: Stance;
  stats: StanceStat[];
  baseline: Omit<StanceStat, 'key' | 'group' | 'label'>;
  /** 回測起點年份 */
  fromYear: string;
  hasTaiex: boolean;
}

/**
 * Fed 立場卡：實質利率、泰勒法則缺口、2Y − Fed 三個數字＋分組回測（之後 12 個月 Fed 往哪走、指數報酬）。
 * 放在政策利率面板的圖與「降息性質判定」之間；參考、不計分。
 */
export function FedStanceCard({ now, stats, baseline, fromYear, hasTaiex }: Props) {
  const [open, setOpen] = useState(false);
  const conflict =
    now.realLean && now.taylorLean && now.realLean !== 'mid' && now.taylorLean !== 'mid' && now.realLean !== now.taylorLean;
  const current = (s: StanceStat) =>
    (s.key === 'real' && s.group === now.realLean) || (s.key === 'taylor' && s.group === now.taylorLean) || (s.key === 'spread' && s.group === now.bet);
  return (
    <div className="fs" aria-label="Fed 立場卡">
      <p className="score num fs-verdict">
        <span className="muted small">Fed 立場（參考，不計分）｜</span> <b>{stanceHeadline(now)}</b>
      </p>
      <div className="table-wrap">
        <table className="bt-table num fs-table">
          <thead>
            <tr>
              <th>三把尺（門檻）</th>
              <th className="r">讀數</th>
              <th>判讀</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                實質利率 <span className="muted small">Fed − 核心CPI</span>
                <br />
                <span className="muted small">&lt; 0 偏鬆、≥ +{REAL_RATE_TIGHT} 偏緊</span>
              </td>
              <td className="r">
                {fpp(now.real)}
                <br />
                <span className="muted small">{f2(now.fed)} − {f1(now.coreCpi)}</span>
              </td>
              <td className="nw">
                {now.realLean ? (
                  <>
                    <Lamp color={LEAN_COLOR[now.realLean]} />
                    {LEAN_TEXT[now.realLean]}
                  </>
                ) : '—'}
              </td>
            </tr>
            <tr>
              <td>
                泰勒缺口 <span className="muted small">法則利率 − Fed</span>
                <br />
                <span className="muted small">≥ +{TAYLOR_BAND} Fed 偏鬆、≤ −{TAYLOR_BAND} Fed 偏緊</span>
              </td>
              <td className="r">
                {fpp(now.taylorGap)}
                <br />
                <span className="muted small">{f2(now.taylor)} − {f2(now.fed)}</span>
              </td>
              <td className="nw">
                {now.taylorLean ? (
                  <>
                    <Lamp color={LEAN_COLOR[now.taylorLean]} />
                    Fed {LEAN_TEXT[now.taylorLean]}
                  </>
                ) : (
                  <span className="muted small">無資料</span>
                )}
              </td>
            </tr>
            <tr>
              <td>
                美債 2Y − Fed <span className="muted small">市場押注</span>
                <br />
                <span className="muted small">≤ −{SPREAD_BAND} 押降息、≥ +{SPREAD_BAND} 押升息</span>
              </td>
              <td className="r">
                {fpp(now.spread)}
                <br />
                <span className="muted small">{f2(now.us2y)} − {f2(now.fed)}</span>
              </td>
              <td className="nw">
                {now.bet ? (
                  <>
                    <Lamp color={BET_COLOR[now.bet]} />
                    {BET_TEXT[now.bet]}
                  </>
                ) : '—'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {now.taylor !== null && (
        <p className="small muted num fs-note">
          法則利率＝{TAYLOR_R_STAR} ＋ 核心PCE {f1(now.corePce)}%（{ym(now.corePceDate)}）＋ 0.5 ×（核心PCE − 2）＋ 0.5 × {OKUN} ×（自然失業率 {f2(now.nrou)} − 失業率 {f1(now.unrate)}）＝ <b>{f2(now.taylor)}%</b>
        </p>
      )}
      {conflict && (
        <p className="small warn fs-note">
          兩把尺方向相反：實質利率只看「Fed 高過通膨多少」，泰勒法則還要求通膨高於 2% 時多升、就業強時多升。相反時以 2Y − Fed（市場押注）對照，回測裡它對 Fed 下一步最準。
        </p>
      )}
      <button type="button" className="linkbtn small" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '收起' : '展開'}回測：讀數落在各組時，之後 12 個月 Fed 往哪走（{fromYear} 起）
      </button>
      {open && (
        <div className="table-wrap">
          <table className="bt-table num">
            <caption className="small muted">
              每月底取樣（月資料加 45 天公布延遲）。全部月份基準：Fed 升 {pct0(baseline.hikePct)}／降 {pct0(baseline.cutPct)}、S&P {pctCell(baseline.ret.spx?.mean ?? null)}
              {hasTaiex && <>、加權 {pctCell(baseline.ret.taiex?.mean ?? null)}</>}。升／降＝12 個月後利率差一碼以上。月份彼此重疊，獨立的升降息循環只有約 7 個；加權 1997 年起（下方小字＝月數）；粗體列＝目前所在組
            </caption>
            <thead>
              <tr>
                <th>當時讀數</th>
                <th className="r">月數</th>
                <th className="r">Fed 升／降</th>
                <th className="r">平均變動</th>
                <th className="r">S&P 12月</th>
                {hasTaiex && <th className="r">加權 12月</th>}
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={`${s.key}-${s.group}`} className={current(s) ? 'hl' : ''}>
                  <td>{s.label}</td>
                  <td className="r">{s.n}</td>
                  <td className="r nw">
                    {pct0(s.hikePct)}／{pct0(s.cutPct)}
                  </td>
                  <td className="r">{fpp(s.fedChg)}</td>
                  <td className="r">{pctCell(s.ret.spx?.mean ?? null)}</td>
                  {hasTaiex && (
                    <td className="r">
                      {pctCell(s.ret.taiex?.mean ?? null)}
                      {(s.ret.taiex?.n ?? 0) > 0 && (
                        <>
                          <br />
                          <span className="small muted">{s.ret.taiex!.n} 月</span>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
