import { useState } from 'react';
import { pctCell } from '../lib/stressFormat';
import {
  BE_HIGH,
  BE_LOW,
  LEVEL_COLOR,
  LEVEL_TEXT,
  MICH_HIGH,
  MICH_LOW,
  WAGE_COLD,
  WAGE_HOT,
  expHeadline,
  type ExpKey,
  type ExpReading,
  type ExpStat,
  type Level,
} from '../shared/inflExpect';

const ym = (d: string | null) => (d ? `${Number(d.slice(5, 7))}月` : '—');
const md = (d: string | null) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}` : '—');
const pct = (v: number | null, d: number) => (v === null ? '—' : `${v.toFixed(d)}%`);
const fpp = (v: number | null, d = 1) => {
  if (v === null) return '—';
  const t = v.toFixed(d);
  // 四捨五入後是 0 的不帶正負號（避免「-0.00pp」）
  return Number(t) === 0 ? `${(0).toFixed(d)}pp` : `${v > 0 ? '+' : ''}${t}pp`;
};
const pct0 = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`);

function Verdict({ k, level }: { k: ExpKey; level: Level | null }) {
  if (!level) return <span className="muted small">無資料</span>;
  return (
    <>
      <i className="lamp" style={{ background: `var(${LEVEL_COLOR[level]})` }} aria-hidden="true" />
      {LEVEL_TEXT[k][level]}
    </>
  );
}

type Base = Omit<ExpStat, 'key' | 'group' | 'label'>;

interface Props {
  now: ExpReading;
  stats: ExpStat[];
  baselines: Record<ExpKey, Base>;
  hasTaiex: boolean;
}

const KEY_NAME: Record<ExpKey, string> = { mich: '密大 1 年預期（1987 起）', be: '5Y5Y（2003 起）', wage: '平均時薪年增（2007 起）' };

/**
 * 通膨預期與薪資卡：密大 1 年通膨預期、5Y5Y、平均時薪年增三個讀數＋分組回測。
 * 放在政策利率面板「Fed 立場卡」下方；參考、不計分（回測：對 Fed 下一步與股市都沒有穩定的分組差異）。
 */
export function InflExpectCard({ now, stats, baselines, hasTaiex }: Props) {
  const [open, setOpen] = useState(false);
  const cur: Record<ExpKey, Level | null> = { mich: now.michLevel, be: now.beLevel, wage: now.wageLevel };
  const split = now.michLevel === 'high' && now.beLevel !== null && now.beLevel !== 'high';
  return (
    <div className="fs ie" aria-label="通膨預期與薪資卡">
      <p className="score num fs-verdict ie-verdict">
        <span className="muted small">通膨預期與薪資（參考，不計分）｜</span> <b>{expHeadline(now)}</b>
      </p>
      <div className="table-wrap">
        <table className="bt-table num ie-table">
          <thead>
            <tr>
              <th>三個讀數（門檻）</th>
              <th className="r">讀數</th>
              <th>判讀</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                密大 1 年通膨預期 <span className="muted small">家庭問卷</span>
                <br />
                <span className="muted small">≥ {MICH_HIGH}% 偏高、≤ {MICH_LOW}% 穩定</span>
              </td>
              <td className="r">
                {pct(now.mich, 1)}
                <br />
                <span className="muted small">{ym(now.michDate)}｜3月 {fpp(now.michChg3)}</span>
              </td>
              <td className="nw"><Verdict k="mich" level={now.michLevel} /></td>
            </tr>
            <tr>
              <td>
                5Y5Y <span className="muted small">債市押的長期通膨</span>
                <br />
                <span className="muted small">≥ {BE_HIGH}% 偏高、≤ {BE_LOW}% 偏低</span>
              </td>
              <td className="r">
                {pct(now.be, 2)}
                <br />
                <span className="muted small">{md(now.beDate)}｜60天 {fpp(now.beChg60, 2)}</span>
              </td>
              <td className="nw"><Verdict k="be" level={now.beLevel} /></td>
            </tr>
            <tr>
              <td>
                平均時薪年增 <span className="muted small">薪資→服務通膨</span>
                <br />
                <span className="muted small">≥ {WAGE_HOT}% 偏熱、≤ {WAGE_COLD}% 偏冷</span>
              </td>
              <td className="r">
                {pct(now.wage, 1)}
                <br />
                <span className="muted small">{ym(now.wageDate)}｜3月 {fpp(now.wageChg3)}</span>
              </td>
              <td className="nw"><Verdict k="wage" level={now.wageLevel} /></td>
            </tr>
          </tbody>
        </table>
      </div>
      {split && (
        <p className="small warn fs-note">
          家庭預期偏高、債市沒跟：密大 1 年預期跟著油價與日常物價跳動；Fed 更在意長期預期有沒有鬆動（5Y5Y 仍在 {BE_HIGH}% 以下）。兩者都偏高才是「預期脫錨」。
        </p>
      )}
      <button type="button" className="linkbtn small" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '收起' : '展開'}回測：讀數落在各組時，之後 12 個月 Fed、核心 CPI、股市
      </button>
      {open && (
        <div className="table-wrap">
          <table className="bt-table num">
            <caption className="small muted">
              每月底取樣（月資料加 45 天公布延遲）。結論：三個讀數對 Fed 下一步與股市都沒有穩定的分組差異，所以不計分。「時薪 ≥ {WAGE_HOT}%」全部落在 2020～2025 一段、「5Y5Y ≥ {BE_HIGH}%」全部在 2003～2014，是時代差異不是規律。各把尺起點不同，基準列＝那把尺有資料的全部月份；粗體列＝目前所在組
            </caption>
            <thead>
              <tr>
                <th>當時讀數</th>
                <th className="r">月數</th>
                <th className="r">Fed 升／降</th>
                <th className="r">核心CPI</th>
                <th className="r">S&P 12月</th>
                {hasTaiex && <th className="r">加權 12月</th>}
              </tr>
            </thead>
            <tbody>
              {(['mich', 'be', 'wage'] as const).flatMap((k) => [
                <tr key={`${k}-base`} className="ie-base">
                  <td className="muted">{KEY_NAME[k]} 基準</td>
                  <td className="r muted">{baselines[k].n}</td>
                  <td className="r nw muted">{pct0(baselines[k].hikePct)}／{pct0(baselines[k].cutPct)}</td>
                  <td className="r muted">{fpp(baselines[k].cpiChg, 2)}</td>
                  <td className="r muted">{pctCell(baselines[k].ret.spx?.mean ?? null)}</td>
                  {hasTaiex && <td className="r muted">{pctCell(baselines[k].ret.taiex?.mean ?? null)}</td>}
                </tr>,
                ...stats
                  .filter((s) => s.key === k)
                  .map((s) => (
                    <tr key={`${s.key}-${s.group}`} className={cur[k] === s.group ? 'hl' : ''}>
                      <td>{s.label}</td>
                      <td className="r">{s.n}</td>
                      <td className="r nw">{pct0(s.hikePct)}／{pct0(s.cutPct)}</td>
                      <td className="r">{fpp(s.cpiChg, 2)}</td>
                      <td className="r">{pctCell(s.ret.spx?.mean ?? null)}</td>
                      {hasTaiex && <td className="r">{pctCell(s.ret.taiex?.mean ?? null)}</td>}
                    </tr>
                  )),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
