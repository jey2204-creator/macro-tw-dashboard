import { useState } from 'react';
import { formatTaipeiDateTime } from '../shared/dates';
import {
  DX_WARN_PCT,
  HIT_MIN_N,
  HIT_USABLE,
  USF_BEAR_PCT,
  USF_BULL_PCT,
  USF_SYMBOLS,
  VERDICT_COLOR,
  VERDICT_TEXT,
  ZN_WARN_PCT,
  type UsfBacktest,
  type UsfFile,
  type UsfId,
  type UsfLatest,
} from '../shared/usFutures';
import { PanelNote } from './PanelNote';

const p2 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`);
const p1 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`);
const rho = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`);
const sign = (v: number | null | undefined) => (v === null || v === undefined ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

const KIND_NOTE: Record<string, string> = {
  nq: '主訊號；台股權值在半導體，跟 NQ 最像',
  es: '整體風險情緒',
  ym: '傳產、金融',
  zn: '價格跌＝殖利率升',
  dx: '美元升＝新興市場資金外流',
  gc: '避險／實質利率',
  cl: '通膨預期',
};

function Lamp({ color }: { color: string }) {
  return <i className="lamp" style={{ background: `var(${color})` }} aria-hidden="true" />;
}

export function UsFuturesPanel({ data }: { data: UsfFile | null }) {
  const [open, setOpen] = useState(false);
  const l = data?.latest ?? null;
  const bt = data?.backtest ?? null;
  return (
    <section id="sec-usf" className="regime ms usf" aria-label="美期隔夜風向">
      <div className="regime-head">
        <div className="regime-title">
          <span className="label">美期隔夜風向（參考，不計分）</span>
        </div>
        {l && (
          <span className="small muted num">
            台股 {md(l.date)}｜美股 {md(l.usDate)} 收盤 → 台北 08:00｜快照 {formatTaipeiDateTime(l.asOf)}
          </span>
        )}
      </div>

      {!data && <p className="small muted">載入中…</p>}
      {data && !l && <p className="small warn">尚無小時資料（第一次排程後才會出現）。</p>}
      {l && bt && <Verdict l={l} bt={bt} />}

      <PanelNote>
        <p className="small muted ms-rule">
          <b>看什麼</b>：台股開盤前只能看到兩件事——昨晚美股現貨怎麼收（已在跨市場對照的費半、NASDAQ 窗格），以及<b>美股收盤後到台北 08:00 這段期貨又動了多少</b>（財報盤後反應、亞洲開盤）。這面板只算後面這一段，叫「隔夜」。
          「台股盤中」是 08:00 → 13:00 期貨的變動，與加權同時段，用來解釋當天為什麼漲跌，不是預測。
        </p>
        <p className="small muted ms-rule">
          <b>判定</b>：NQ 隔夜 ≥ +{USF_BULL_PCT}% → 偏多開局、≤ {USF_BEAR_PCT}% → 偏空開局，其餘中性；配角警訊：美債期貨 ≤ {ZN_WARN_PCT}%（殖利率急升）、美元指數 ≥ +{DX_WARN_PCT}%、NQ 與 ES 方向相反。
          判定只在回測「|NQ 隔夜| ≥ {USF_BULL_PCT}% 的日子，加權開盤同向 ≥ {HIT_USABLE}%、樣本 ≥ {HIT_MIN_N}」時才亮燈，否則只顯示數字。
        </p>
        <p className="small muted ms-rule">
          <b>資料</b>：Yahoo 60 分鐘 K：CME 近月期貨 NQ、ES、YM、ZN、GC、CL 與 ICE 美元指數 DXY（期貨 DX=F 沒有盤中資料，改用指數），時間戳為整點起點：美股現貨收盤＝起點 15:00 ET 那根、台北 08:00＝起點 07:00 台北那根（夏令 20:00 ET／冬令 19:00 ET，CME 兩季都有交易）。
          小時 K 只能回溯約 2 年，之後靠每日快照累積，所以回測樣本從 {bt?.start ?? '—'} 起。平日 08:45 多跑一次排程，所以 09:00 開盤前看得到今天的隔夜讀數；排程偶爾晚 5～15 分鐘，以「快照」時間為準。
          亞洲時段期貨成交量只有美盤的 5～10%，單筆大單可造成假突破，別把 ±0.2% 內的波動當訊號。
        </p>
      </PanelNote>

      {bt && bt.n > 0 && (
        <>
          <button type="button" className="linkbtn small" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? '收起' : '展開'}回測表（NQ 隔夜分組、各商品相關、逐年）
          </button>
          {open && <Tables bt={bt} />}
        </>
      )}
    </section>
  );
}

function Verdict({ l, bt }: { l: UsfLatest; bt: UsfBacktest }) {
  const nq = l.on.nq;
  const b = l.bucket;
  return (
    <>
      <p className="score num cr-verdict">
        NQ 隔夜 <b className={sign(nq)}>{p2(nq)}</b>{' '}
        {bt.usable ? (
          <>
            <Lamp color={VERDICT_COLOR[l.verdict]} />
            <b>{VERDICT_TEXT[l.verdict]}</b>
          </>
        ) : (
          <span className="muted small">（回測同向 {bt.hit ?? '—'}%，n={bt.hitN}，未達 {HIT_USABLE}%／{HIT_MIN_N} → 不判多空，只顯示數字）</span>
        )}
        {b && (
          <span className="muted small">
            ｜歷史同區間（{b.label}，n={b.n}）加權開盤平均 {p1(b.gap)}、當日 {p1(b.day)}、同向 {b.hit ?? '—'}%
          </span>
        )}
        {l.gap !== null && (
          <span className="small">
            ｜實際：加權開盤 <span className={sign(l.gap)}>{p2(l.gap)}</span>、當日 <span className={sign(l.day)}>{p2(l.day)}</span>
          </span>
        )}
      </p>
      {l.warnings.length > 0 && <p className="small warn usf-warn">⚠ {l.warnings.join('；')}</p>}
      <div className="table-wrap">
        <table className="bt-table num usf-table">
          <thead>
            <tr>
              <th>商品</th>
              <th className="r">隔夜</th>
              <th className="r">
                台股盤中
                <br />
                <span className="muted">08:00→{l.ssToHour ?? 13}:00{l.ssPartial ? '（進行中）' : ''}</span>
              </th>
              <th>看什麼</th>
            </tr>
          </thead>
          <tbody>
            {USF_SYMBOLS.map((s) => {
              const on = l.on[s.id as UsfId];
              const ss = l.ss[s.id as UsfId];
              if (on === undefined && ss === undefined) return null;
              return (
                <tr key={s.id} className={s.id === 'nq' ? 'hl' : undefined}>
                  <td className="nw">
                    {s.short} <span className="muted small">{s.name}</span>
                  </td>
                  <td className={`r ${sign(on)}`}>{p2(on)}</td>
                  <td className={`r ${sign(ss)}`}>{p2(ss)}</td>
                  <td className="muted small">{KIND_NOTE[s.id]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Tables({ bt }: { bt: UsfBacktest }) {
  const nq = bt.corr.find((c) => c.id === 'nq');
  return (
    <>
      <p className="small muted">
        {bt.start}～{bt.end}，{bt.n} 個台股交易日。NQ 隔夜 vs 加權開盤跳空 ρ {rho(nq?.gap)}、扣掉費半前一日後 {rho(nq?.gapExSox)}；vs 當日 {rho(nq?.day)}、vs 開到收 {rho(nq?.oc)}。盤中 08:00→13:00 vs 開到收 {rho(nq?.session)}（同時段，解釋力）。
      </p>
      <div className="table-wrap">
        <table className="bt-table num">
          <caption className="small muted">① NQ 隔夜變動分組 → 當天加權（%）；同向＝開盤跳空方向與 NQ 隔夜一致</caption>
          <thead>
            <tr>
              <th>NQ 隔夜</th>
              <th className="r">天數</th>
              <th className="r">開盤跳空</th>
              <th className="r">當日</th>
              <th className="r">開到收</th>
              <th className="r">同向</th>
              <th className="r">當日上漲</th>
            </tr>
          </thead>
          <tbody>
            {bt.buckets.map((b) => (
              <tr key={b.key}>
                <td>{b.label}</td>
                <td className="r">{b.n}</td>
                <td className={`r ${sign(b.gap)}`}>{p1(b.gap)}</td>
                <td className={`r ${sign(b.day)}`}>{p1(b.day)}</td>
                <td className={`r ${sign(b.oc)}`}>{p1(b.oc)}</td>
                <td className="r">{b.hit ?? '—'}%</td>
                <td className="r">{b.up ?? '—'}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-wrap">
        <table className="bt-table num">
          <caption className="small muted">② 各商品隔夜變動 vs 加權（相關係數）；扣費半＝偏相關，看期貨隔夜這段有沒有「昨晚美股」以外的資訊</caption>
          <thead>
            <tr>
              <th>商品</th>
              <th className="r">天數</th>
              <th className="r">開盤跳空</th>
              <th className="r">扣費半</th>
              <th className="r">當日</th>
              <th className="r">開到收</th>
              <th className="r">盤中→開到收</th>
            </tr>
          </thead>
          <tbody>
            {bt.corr.map((c) => (
              <tr key={c.id} className={c.id === 'nq' ? 'hl' : undefined}>
                <td className="nw">{USF_SYMBOLS.find((s) => s.id === c.id)?.short}</td>
                <td className="r">{c.n}</td>
                <td className="r">{rho(c.gap)}</td>
                <td className="r">{rho(c.gapExSox)}</td>
                <td className="r">{rho(c.day)}</td>
                <td className="r">{rho(c.oc)}</td>
                <td className="r">{rho(c.session)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-wrap">
        <table className="bt-table num">
          <caption className="small muted">③ 逐年：NQ 隔夜 vs 開盤跳空的相關、|NQ 隔夜| ≥ {USF_BULL_PCT}% 的同向比例（看關係穩不穩）</caption>
          <thead>
            <tr>
              <th>年</th>
              <th className="r">天數</th>
              <th className="r">ρ 跳空</th>
              <th className="r">同向</th>
            </tr>
          </thead>
          <tbody>
            {bt.yearly.map((y) => (
              <tr key={y.year}>
                <td>{y.year}</td>
                <td className="r">{y.n}</td>
                <td className="r">{rho(y.gap)}</td>
                <td className="r">{y.hit ?? '—'}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
