import { useMemo, useState } from 'react';
import { useSeriesMap } from '../hooks/useData';
import { pctCell } from '../lib/stressFormat';
import {
  analyzeBtcTw,
  BTC_CRASH_PCT,
  CRASH_GAP_DAYS,
  INCR_USEFUL,
  INCR_WEAK,
  SOX_CALM_PCT,
  VERDICT_COLOR,
  VERDICT_TEXT,
  type BtcTwAnalysis,
} from '../shared/btcTw';

const IDS = ['taiex', 'btc', 'sox'];

const rho = (v: number | null) => (v === null ? '—' : `${v >= 0 ? ' ' : '−'}${Math.abs(v).toFixed(2)}`);
const p2 = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`);
const sign = (v: number | null) => (v === null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

function Lamp({ color }: { color: string }) {
  return <i className="lamp" style={{ background: `var(${color})` }} aria-hidden="true" />;
}

/** 結論句：由數字自動產生（2020 起為主） */
function findings(a: BtcTwAnalysis): string[] {
  const late = a.corr.find((c) => c.period.key === 'late')!;
  const early = a.corr.find((c) => c.period.key === 'early')!;
  const gl = a.gap.find((g) => g.period.key === 'late')!;
  const crashAll = a.crash.find((c) => c.period.key === 'late' && c.key === 'all');
  const crashCalm = a.crash.find((c) => c.period.key === 'late' && c.key === 'calm');
  const base = a.crash.find((c) => c.period.key === 'late' && c.key === 'base');
  const big = gl.buckets[0]!;
  const out: string[] = [];
  out.push(
    `同步：2020 起比特幣與加權日報酬相關 ${rho(late.btc).trim()}（2015–2019 只有 ${rho(early.btc).trim()}），費半是 ${rho(late.sox).trim()}；扣掉費半後只剩 ${rho(late.btcExSox).trim()} → 大部分是同一個「美國風險胃口」。前一天比特幣對今天加權 ${rho(late.btcLag).trim()}，沒有領先。`,
  );
  if (crashAll && crashCalm && base)
    out.push(
      `大跌：比特幣單日 ≤ ${BTC_CRASH_PCT}% 的 ${crashAll.n} 次，加權當天平均 ${p2(crashAll.d0)}；但其中費半沒跌（≥ ${SOX_CALM_PCT}%）的 ${crashCalm.n} 次只有 ${p2(crashCalm.d0)}（平常日 ${p2(base.d0)}）→ 比特幣自己跌，台股不跟。`,
    );
  const top = gl.buckets.at(-1)!;
  const sym = top.resid !== null && top.resid > 0.3 ? '大漲也有對稱的正報酬' : '大漲沒有對稱效果';
  out.push(
    big.resid !== null && big.resid <= -0.5
      ? `週末：唯一有額外資訊的地方。台股休市期間比特幣跌 ≥ 5% 的 ${big.n} 次，休市後第一天加權平均 ${p2(big.close)}、上漲機率 ${big.up === null ? '—' : big.up.toFixed(0)}%，扣掉費半後仍 ${p2(big.resid)}；但${sym}，樣本也少。`
      : `週末：台股休市期間比特幣跌 ≥ 5% 的 ${big.n} 次，休市後第一天加權平均 ${p2(big.close)}，扣掉費半後 ${p2(big.resid)}，看不出額外資訊。`,
  );
  return out;
}

/**
 * 比特幣 vs 加權回測：放在跨市場對照面板最下面；參考、不計分。
 * 結論與目前讀數一直顯示，四張回測表收合。
 */
export function BtcTwCard({ version, near }: { version: string; near: boolean }) {
  const [open, setOpen] = useState(false);
  const files = useSeriesMap(near ? IDS : [], version);
  const ready = IDS.every((id) => files[id]?.status === 'ready');
  const a = useMemo(() => {
    if (!ready) return null;
    const get = (id: string) => (files[id]!.status === 'ready' ? (files[id] as { data: { data: [string, number, number, number, number][] } }).data.data : []);
    return analyzeBtcTw(get('taiex'), get('btc'), get('sox'));
  }, [ready, files]);

  const failed = IDS.filter((id) => files[id]?.status === 'error');
  return (
    <div className="cr btc" aria-label="比特幣 vs 加權回測">
      <p className="score num cr-verdict">
        <span className="muted small">₿ 比特幣 vs 加權（回測・參考、不計分）</span>
      </p>
      {failed.length > 0 && <p className="small warn">載入失敗：{failed.join('、')}</p>}
      {!a ? (
        failed.length === 0 && <p className="small muted">載入中…</p>
      ) : (
        <BtcBody a={a} open={open} setOpen={setOpen} />
      )}
    </div>
  );
}

function BtcBody({ a, open, setOpen }: { a: BtcTwAnalysis; open: boolean; setOpen: (v: boolean) => void }) {
  const { verdict, score } = a.verdict;
  const n = a.now;
  const lateGap = a.gap.find((g) => g.period.key === 'late')!;
  const pending = n?.pendingGap ?? null;
  const pendingBucket = pending ? (lateGap.buckets.find((b) => b.n > 0 && inBucket(pending.pct, b.key)) ?? null) : null;
  return (
    <>
      <p className="score num cr-verdict">
        <Lamp color={VERDICT_COLOR[verdict]} />
        <b>2020 起：{VERDICT_TEXT[verdict]}</b>{' '}
        <span className="muted small">（扣掉費半後相關 {score === null ? '—' : score.toFixed(2)}；≥ {INCR_USEFUL} 有用、≥ {INCR_WEAK} 微弱）</span>
      </p>
      {n && (
        <p className="small num btc-now">
          比特幣 <b>{Math.round(n.close).toLocaleString('en-US')}</b> <span className="muted">（{n.date} UTC）</span>{' '}
          20 日 <span className={sign(n.chg20)}>{pctCell(n.chg20)}</span>｜ρ60 比特幣 {rho(n.rho60Btc).trim()} vs 費半 {rho(n.rho60Sox).trim()}
          {pending && (
            <>
              <br />
              台股休市中（{md(pending.from)} 收盤後 → {md(pending.to)}）比特幣 <b className={sign(pending.pct)}>{p2(pending.pct)}</b>
              {pendingBucket && (
                <span className={pending.pct <= -5 ? 'warn' : 'muted'}>
                  {' '}
                  → 2020 起同區間（{pendingBucket.label}）休市後第一天加權平均 {p2(pendingBucket.close)}、上漲 {pendingBucket.up?.toFixed(0)}%（n={pendingBucket.n}）
                </span>
              )}
            </>
          )}
          {!pending && n.lastGap && (
            <>
              <br />
              <span className="muted">
                上次休市（→ {md(n.lastGap.date)}）比特幣 {p2(n.lastGap.btcGap)}，加權當天 {p2(n.lastGap.close)}
              </span>
            </>
          )}
        </p>
      )}
      <ul className="small btc-find">
        {findings(a).map((t) => (
          <li key={t.slice(0, 4)}>{t}</li>
        ))}
      </ul>

      <button type="button" className="linkbtn small" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '收起' : '展開'}回測表（相關、年度、休市期間、大跌事件）
      </button>
      {open && <BtcTables a={a} />}
    </>
  );
}

function inBucket(v: number, key: string): boolean {
  const lo: Record<string, number> = { b1: -Infinity, b2: -5, b3: -2, b4: 2, b5: 5 };
  const hi: Record<string, number> = { b1: -5, b2: -2, b3: 2, b4: 5, b5: Infinity };
  return v > lo[key]! && v <= hi[key]!;
}

function BtcTables({ a }: { a: BtcTwAnalysis }) {
  return (
    <>
      <div className="table-wrap">
        <table className="bt-table num">
          <caption className="small muted">
            ① 日報酬相關：比特幣與費半都對齊到「台股開盤前看到的那根」；扣費半＝加權先扣掉費半能解釋的部分，再看比特幣還剩多少（偏相關）
          </caption>
          <thead>
            <tr>
              <th>期間</th>
              <th className="r">天數</th>
              <th className="r">比特幣</th>
              <th className="r">費半</th>
              <th className="r hl">扣費半</th>
              <th className="r">前一天比特幣</th>
            </tr>
          </thead>
          <tbody>
            {a.corr.map((c) => (
              <tr key={c.period.key} className={c.period.key === 'all' ? 'all' : ''}>
                <td className="nw">{c.period.label}</td>
                <td className="r">{c.n}</td>
                <td className="r">{rho(c.btc)}</td>
                <td className="r">{rho(c.sox)}</td>
                <td className="r">
                  <b>{rho(c.btcExSox)}</b>
                </td>
                <td className="r">{rho(c.btcLag)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-wrap">
        <table className="bt-table num">
          <caption className="small muted">② 逐年相關：看關係是否穩定（每年差很多＝不能當固定規則用）</caption>
          <thead>
            <tr>
              <th>年</th>
              <th className="r">比特幣</th>
              <th className="r">費半</th>
              <th className="r">扣費半</th>
            </tr>
          </thead>
          <tbody>
            {a.years.map((y) => (
              <tr key={y.year}>
                <td>
                  {y.year}
                  {y.n < 200 && <span className="small muted">（{y.n}天）</span>}
                </td>
                <td className="r">{rho(y.btc)}</td>
                <td className="r">{rho(y.sox)}</td>
                <td className="r">{rho(y.btcExSox)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-wrap">
        <table className="bt-table num">
          <caption className="small muted">
            ③ 休市期間（週末、連假）比特幣漲跌 vs 休市後第一天加權：從上個台股日那根 UTC 日 K 收盤（台北隔天 08:00，已過美股收盤）算到開盤日 08:00，是費半看不到的時段。扣費半＝收盤 − β×前一晚費半
          </caption>
          <thead>
            <tr>
              <th>比特幣</th>
              <th className="r">次數</th>
              <th className="r">開盤跳空</th>
              <th className="r">收盤</th>
              <th className="r">上漲</th>
              <th className="r hl">扣費半</th>
            </tr>
          </thead>
          <tbody>
            {a.gap
              .filter((g) => g.period.key !== 'all')
              .slice()
              .reverse()
              .flatMap((g) => [
                <tr key={`${g.period.key}-h`} className="grp">
                  <td colSpan={6}>
                    {g.period.label}
                    <span className="small muted">
                      {' '}
                      n={g.n}｜相關 收盤 {rho(g.corrClose).trim()}・扣費半 {rho(g.corrResid).trim()}・開盤 {rho(g.corrOpen).trim()}・開盤扣費半{' '}
                      {rho(g.corrOpenResid).trim()}
                    </span>
                  </td>
                </tr>,
                ...g.buckets.map((b) => (
                  <tr key={`${g.period.key}-${b.key}`}>
                    <td className="nw">{b.label}</td>
                    <td className="r">{b.n}</td>
                    <td className={`r ${sign(b.open)}`}>{p2(b.open)}</td>
                    <td className={`r ${sign(b.close)}`}>{p2(b.close)}</td>
                    <td className="r">{b.up === null ? '—' : `${b.up.toFixed(0)}%`}</td>
                    <td className={`r ${sign(b.resid)}`}>
                      <b>{p2(b.resid)}</b>
                    </td>
                  </tr>
                )),
              ])}
          </tbody>
        </table>
      </div>

      <div className="table-wrap">
        <table className="bt-table num">
          <caption className="small muted">
            ④ 比特幣大跌（對齊後單日 ≤ {BTC_CRASH_PCT}%，前一次後 {CRASH_GAP_DAYS} 個交易日內不重複計）之後的加權；「費半 ≥ {SOX_CALM_PCT}%」＝美股沒一起跌的那些天
          </caption>
          <thead>
            <tr>
              <th>條件</th>
              <th className="r">次數</th>
              <th className="r">當天</th>
              <th className="r">下跌</th>
              <th className="r">5日</th>
              <th className="r">20日</th>
            </tr>
          </thead>
          <tbody>
            {['late', 'all'].flatMap((pk) => {
              const rows = a.crash.filter((c) => c.period.key === pk);
              if (!rows.length) return [];
              return [
                <tr key={`${pk}-h`} className="grp">
                  <td colSpan={6}>{rows[0]!.period.label}</td>
                </tr>,
                ...rows.map((c) => (
                  <tr key={`${pk}-${c.key}`} className={c.key === 'base' ? 'all' : ''}>
                    <td className="nw">{c.label}</td>
                    <td className="r">{c.n}</td>
                    <td className={`r ${sign(c.d0)}`}>{p2(c.d0)}</td>
                    <td className="r">{c.d0Down === null ? '—' : `${c.d0Down.toFixed(0)}%`}</td>
                    <td className={`r ${sign(c.d5)}`}>{p2(c.d5)}</td>
                    <td className={`r ${sign(c.d20)}`}>{p2(c.d20)}</td>
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        限制：樣本內結果；週末大跌只有約 20 次，且常跟週末新聞同時發生（例如 2024-08-05 日圓套利平倉），不能確定是比特幣「造成」的。比特幣價格為 Yahoo 彙整報價（BTC-USD，UTC 日 K），2014-09 起。
      </p>
    </>
  );
}
