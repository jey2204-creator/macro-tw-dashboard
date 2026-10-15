import { formatChange, formatSigned, formatValue, shortDate } from '../lib/format';
import { releaseLines } from '../lib/release';
import type { IndicatorReleases } from '../shared/calendar';
import { statusTags, type RowModel } from '../lib/rows';
import { CATEGORY_LABEL, CATEGORY_ORDER, INDICATOR_MAP, toneClass } from '../shared/indicators';
import { SIGNAL_LABEL } from '../shared/regime';
import { quarterLabel, sumLast } from '../shared/signals';
import { SignalBadge } from './SignalBadge';
import { fmtValue, impactPieces, thresholdPieces } from '../lib/outlookText';
import type { IndicatorOutlook } from '../shared/outlook';
import { countdownText, releaseAt, RELEASE_KINDS, whenText } from '../shared/schedule';

/** 下次公布：時間、倒數、翻轉門檻、對總分的影響 */
function NextRelease({ o, nowScore, now }: { o: IndicatorOutlook; nowScore: number; now: Date }) {
  const def = INDICATOR_MAP[o.id]!;
  const r = o.release;
  const pieces = thresholdPieces(o);
  const impacts = impactPieces(o, nowScore);
  return (
    <span className="c-next">
      <span className="next-head">
        ⏰ 下次 {whenText(r)}
        <span className="next-cd">（{countdownText(releaseAt(r), now)}）</span>
        {r.note && <span className="next-note">{r.note}</span>}
        {r.kind === 'gdpnow' && <span className="next-note">{RELEASE_KINDS.gdpnow.source}</span>}
      </span>
      {o.pendingData && <span className="next-line warn">上次公布的數據尚未更新進網站，門檻待資料更新後計算</span>}
      {pieces.length > 0 && (
        <span className="next-line">
          {pieces.map((p, i) => (
            <span key={i} className={`th sig-${p.signal}${p.current ? ' cur' : ''}`}>
              {p.text} → {SIGNAL_LABEL[p.signal]}
            </span>
          ))}
        </span>
      )}
      {(o.forecast || o.policy?.holdNeutralFrom) && (
        <span className="next-line">
          {o.forecast && (
            <span>
              市場預期 {fmtValue(def, o.forecast.value)} → {SIGNAL_LABEL[o.forecast.signal]}
            </span>
          )}
          {o.policy?.holdNeutralFrom && (
            <span>若一直不變，{o.policy.holdNeutralFrom.slice(5).replace('-', '/')} 起轉中性（升息滿 120 天）</span>
          )}
        </span>
      )}
      {impacts.length > 0 && (
        <span className="next-line">
          {impacts.map((p) => (
            <span key={p.signal} className={p.flips ? 'flip' : undefined}>
              {p.flips && '⚠️ '}
              {p.text}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
import { Sparkline } from './Sparkline';

const ARROW = { up: '▲', down: '▼', flat: '▶' } as const;

function Row({
  row,
  today,
  selected,
  onSelect,
  releases,
  outlook,
  nowScore,
  now,
}: {
  row: RowModel;
  today: string;
  selected: boolean;
  onSelect: (id: string) => void;
  releases?: IndicatorReleases;
  outlook?: IndicatorOutlook;
  nowScore: number;
  now: Date;
}) {
  const { def } = row.ev;
  const last = row.change.last;
  // 流量型（買賣超、增減）：變化欄改顯示 5 日累計，比單日差值更有意義
  const sum5 = def.flow ? sumLast(row.ev.points, 5) : null;
  const ch = def.flow
    ? { main: formatSigned(def, sum5), sub: '5日計' }
    : formatChange(def, row.change.abs, row.change.pct);
  const chVal = def.flow ? sum5 : row.change.abs;
  const chDir = toneClass(def, chVal === null ? '' : chVal > 0 ? 'up' : chVal < 0 ? 'down' : '');
  const trendTone = toneClass(def, row.direction.dir) || 'flat';
  const dateText = def.frequency === 'quarterly' && last ? quarterLabel(last[0]) : shortDate(last?.[0], today);
  const value =
    def.pairId && row.pairValue !== null && last
      ? `${row.pairValue.toFixed(2)}–${last[1].toFixed(2)}%`
      : def.flow
        ? formatSigned(def, last?.[1] ?? null)
        : formatValue(def, last?.[1]);
  const tags = statusTags(row);
  // 有官方日程時，「下次」改由 NextRelease 顯示（含門檻），避免重複
  const relLines = releaseLines(releases).filter((l) => !(outlook && l.head.startsWith('下次')));
  return (
    <li>
      <button
        type="button"
        className={`row${selected ? ' selected' : ''}`}
        onClick={() => onSelect(def.id)}
        aria-label={`${def.name} ${value}，開啟圖表`}
      >
        <span className="c-name">
          <span className="name">{def.short}</span>
          <span className="date">
            {dateText}
            {tags.map((t) => (
              <span key={t.text} className={`tag ${t.cls}`} title={t.title}>
                {t.text}
              </span>
            ))}
          </span>
        </span>
        <span className="c-val num">{value}</span>
        <span className={`c-chg num ${chDir}`}>
          <span>{ch.main}</span>
          {ch.sub && <span className="sub">{ch.sub}</span>}
        </span>
        <span className="c-trend">
          <Sparkline points={row.ev.points.slice(def.frequency === 'daily' ? -60 : -24)} dir={trendTone} />
          <span className={`dir ${trendTone}`}>
            {ARROW[row.direction.dir]} {row.direction.text}
          </span>
        </span>
        <span className="c-sig">
          <SignalBadge
            signal={row.ev.signal.signal}
            info={def.rule.kind === 'info'}
            muted={!row.ev.counted}
            title={`${row.ev.signal.reason}\n規則：${row.ev.signal.ruleText}${row.ev.excludedReason ? `\n不計分：${row.ev.excludedReason}` : ''}`}
          />
        </span>
        {/* 判斷依據直接寫在列上：手機沒有 hover，不必點開就知道為什麼是偏多／偏空 */}
        {def.rule.kind !== 'info' && (
          <span className="c-reason">
            {row.ev.signal.reason} → {SIGNAL_LABEL[row.ev.signal.signal]}
            {row.ev.excludedReason && <span className="warn">（不計分：{row.ev.excludedReason}）</span>}
          </span>
        )}
        {/* 公布日／實績／市場預期（僅供參考，不計分） */}
        {relLines.map((l) => (
          <span key={l.head} className="c-release">
            <span className="rel-head">{l.head}</span>
            {l.parts.map((p) => (
              <span key={p.text} className={`rel-part ${p.dir}`} title={p.title}>
                {p.text}
              </span>
            ))}
          </span>
        ))}
        {outlook && <NextRelease o={outlook} nowScore={nowScore} now={now} />}
      </button>
    </li>
  );
}

export function IndicatorTable({
  rows,
  today,
  selectedId,
  onSelect,
  releases = {},
  outlooks = {},
  nowScore = 0,
  now = new Date(),
}: {
  rows: RowModel[];
  today: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  releases?: Record<string, IndicatorReleases>;
  outlooks?: Record<string, IndicatorOutlook>;
  nowScore?: number;
  now?: Date;
}) {
  return (
    <div className="groups">
      {CATEGORY_ORDER.map((cat) => {
        const list = rows.filter((r) => r.ev.def.category === cat);
        if (list.length === 0) return null;
        return (
          <section key={cat} className="group" aria-label={CATEGORY_LABEL[cat]}>
            <h2 className="group-head">
              <span>{CATEGORY_LABEL[cat]}</span>
              <span className="cols muted" aria-hidden="true">
                <span>數值</span>
                <span>{cat === 'macro' ? '前期變化' : cat === 'tw_chips' ? '前日比/5日計' : '日變化'}</span>
                <span>近期</span>
                <span>判斷</span>
              </span>
            </h2>
            <ul>
              {list.map((r) => (
                <Row
                  key={r.ev.def.id}
                  row={r}
                  today={today}
                  selected={selectedId === r.ev.def.id}
                  onSelect={onSelect}
                  releases={releases[r.ev.def.id]}
                  outlook={outlooks[r.ev.def.id]}
                  nowScore={nowScore}
                  now={now}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
