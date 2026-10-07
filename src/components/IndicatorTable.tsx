import { formatChange, formatValue, shortDate } from '../lib/format';
import { statusTags, type RowModel } from '../lib/rows';
import { CATEGORY_LABEL, CATEGORY_ORDER } from '../shared/indicators';
import { quarterLabel } from '../shared/signals';
import { SignalBadge } from './SignalBadge';
import { Sparkline } from './Sparkline';

const ARROW = { up: '▲', down: '▼', flat: '▶' } as const;

function Row({ row, today, selected, onSelect }: { row: RowModel; today: string; selected: boolean; onSelect: (id: string) => void }) {
  const { def } = row.ev;
  const last = row.change.last;
  const ch = formatChange(def, row.change.abs, row.change.pct);
  const chDir = row.change.abs === null ? '' : row.change.abs > 0 ? 'up' : row.change.abs < 0 ? 'down' : '';
  const dateText = def.frequency === 'quarterly' && last ? quarterLabel(last[0]) : shortDate(last?.[0], today);
  const value =
    def.pairId && row.pairValue !== null && last
      ? `${row.pairValue.toFixed(2)}–${last[1].toFixed(2)}%`
      : formatValue(def, last?.[1]);
  const tags = statusTags(row);
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
          <Sparkline points={row.ev.points.slice(def.frequency === 'daily' ? -60 : -24)} dir={row.direction.dir} />
          <span className={`dir ${row.direction.dir}`}>
            {ARROW[row.direction.dir]} {row.direction.text}
          </span>
        </span>
        <span className="c-sig">
          <SignalBadge
            signal={row.ev.signal.signal}
            muted={!row.ev.counted}
            title={`${row.ev.signal.reason}\n規則：${row.ev.signal.ruleText}${row.ev.excludedReason ? `\n不計分：${row.ev.excludedReason}` : ''}`}
          />
        </span>
      </button>
    </li>
  );
}

export function IndicatorTable({
  rows,
  today,
  selectedId,
  onSelect,
}: {
  rows: RowModel[];
  today: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
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
                <span>{cat === 'macro' ? '前期變化' : '日變化'}</span>
                <span>近期</span>
                <span>判斷</span>
              </span>
            </h2>
            <ul>
              {list.map((r) => (
                <Row key={r.ev.def.id} row={r} today={today} selected={selectedId === r.ev.def.id} onSelect={onSelect} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
