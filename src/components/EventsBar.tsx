import { useState } from 'react';
import { jumpTo } from '../lib/jump';
import { rangeText } from '../lib/outlookText';
import { GEO_TYPE_TEXT, geoCountdown, geoStartAt, geoWhenText, upcomingGeo, type GeoEvent } from '../shared/geoEvents';
import { INDICATOR_MAP } from '../shared/indicators';
import {
  holidayCountdown,
  holidayHint,
  holidayId,
  holidaysEndSoon,
  holidayStartAt,
  holidayTitle,
  holidayWhenText,
  MARKET_TEXT,
  upcomingHolidays,
  type HolidaySpan,
} from '../shared/marketHolidays';
import { eventRange, type IndicatorOutlook } from '../shared/outlook';
import type { Regime } from '../shared/regime';
import {
  countdownText,
  RELEASE_KINDS,
  releaseAt,
  scheduleEndsSoon,
  upcomingReleases,
  whenText,
  type ReleaseKind,
  type ScheduledRelease,
} from '../shared/schedule';

/** 頁首：接下來 14 天的總經公布（美國＋台灣）＋每一場最好／最壞會讓總分變多少；重大事件（APEC、G20、關稅期限、選舉…）與美股／台股休市日一併列出、不計分 */
export function EventsBar({
  regime,
  outlooks,
  now,
  onSelect,
  icsPath = 'data/macro-events.ics',
}: {
  regime: Regime;
  outlooks: Record<string, IndicatorOutlook>;
  now: Date;
  onSelect: (id: string) => void;
  /** 行事曆檔路徑（含網站 base） */
  icsPath?: string;
}) {
  const [all, setAll] = useState(false);
  const days = all ? 60 : 14;
  const list = upcomingReleases(now, days);
  // GDPNow 更新頻繁：只列最近一次，避免洗版
  const firstNow = list.find((r) => r.kind === 'gdpnow');
  const shown = list.filter((r) => RELEASE_KINDS[r.kind].importance === 'high' || r === firstNow);
  // 重大事件（人工清單）：和公布日程依時間混排；沒有精確時刻，排在當天最前面
  const rows: Row[] = [
    ...shown.map((r): Row => ({ at: releaseAt(r), r })),
    ...upcomingGeo(now, days).map((g): Row => ({ at: geoStartAt(g), g })),
    // 休市／提早收盤（交易所公告）：當地日期，排在當天最前面
    ...upcomingHolidays(now, days).map((h): Row => ({ at: holidayStartAt(h), h })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const holEnd = holidaysEndSoon(now);
  const stale = (Object.keys(RELEASE_KINDS) as ReleaseKind[])
    .map((k) => ({ k, end: scheduleEndsSoon(k, now) }))
    .filter((x) => x.end);

  const icsHttps = typeof window !== 'undefined' ? new URL(icsPath, window.location.href).href : icsPath;
  const webcal = icsHttps.replace(/^https?:/, 'webcal:');

  return (
    <section className="events" aria-label="接下來的總經公布">
      <div className="events-head">
        <span className="label">📅 接下來 {days} 天公布</span>
        <span className="events-tools">
          <a className="linkbtn" href={webcal} title="手機行事曆訂閱：自動同步日程與門檻，公布前 30 分鐘提醒">
            訂閱行事曆
          </a>
          <a className="linkbtn" href={icsPath} download="macro-events.ics">
            下載 .ics
          </a>
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="muted small">這段期間沒有排定的公布</p>
      ) : (
        <ul className="events-list">
          {rows.map((row) =>
            row.r ? (
              <EventRow key={`${row.r.kind}-${row.r.date}`} r={row.r} regime={regime} outlooks={outlooks} now={now} onSelect={onSelect} />
            ) : row.g ? (
              <GeoRow key={row.g.id} g={row.g} now={now} />
            ) : (
              <HolidayRow key={holidayId(row.h)} h={row.h} now={now} />
            ),
          )}
        </ul>
      )}
      <div className="events-foot small muted">
        <button type="button" className="linkbtn" onClick={() => setAll(!all)}>
          {all ? '只看 14 天' : '看 60 天'}
        </button>
        <span>台北時間；區間＝這次公布最好／最壞情況下的總分（只算這一項，美債、美元會另外反應）；台灣指標僅供參考；ADP、密大、零售銷售、財報季＝參考事件（不計分、不設提醒）；🌐＝重大事件（當地日期，人工清單、不計分）；🇺🇸🇹🇼 休市＝交易所公告（美股為美東日期；颱風等臨時休市不在內）</span>
      </div>
      {holEnd.length > 0 && (
        <p className="warn small">
          休市日清單即將用完：{holEnd.map((x) => `${MARKET_TEXT[x.market].name}（至 ${x.through}）`).join('、')}，請更新 config/market-holidays.json
        </p>
      )}
      {stale.length > 0 && (
        <p className="warn small">
          日程即將用完：{stale.map((x) => `${RELEASE_KINDS[x.k].name}（至 ${x.end}）`).join('、')}，請更新 src/shared/schedule.ts
        </p>
      )}
    </section>
  );
}

type Row =
  | { at: string; r: ScheduledRelease; g?: undefined; h?: undefined }
  | { at: string; g: GeoEvent; r?: undefined; h?: undefined }
  | { at: string; h: HolidaySpan; r?: undefined; g?: undefined };

/** 休市／提早收盤列：只提醒日期，不可點、不計分 */
function HolidayRow({ h, now }: { h: HolidaySpan; now: Date }) {
  const cd = holidayCountdown(h, now);
  const t = holidayTitle(h);
  const hint = holidayHint(h);
  return (
    <li>
      <button type="button" className="event ev-ref ev-hol" title={hint}>
        <span className={`ev-cd${cd === '今天' || cd === '明天' || cd === '進行中' ? ' soon' : ''}`}>{cd}</span>
        <span className="ev-main">
          <span className="ev-name">
            {t.head}
            <span className="muted">｜{t.name}</span>
          </span>
          <span className="ev-when num">{holidayWhenText(h)}</span>
        </span>
        <span className="ev-impact small">
          <span className="muted">不計分｜{hint}</span>
        </span>
      </button>
    </li>
  );
}

/** 重大事件列：沒有數字可算門檻，只提醒日期；點了跳到跨市場對照（事後看加權 K 棒上的 ■ 標記） */
function GeoRow({ g, now }: { g: GeoEvent; now: Date }) {
  const cd = geoCountdown(g, now);
  return (
    <li>
      <button type="button" className="event ev-geo" onClick={() => jumpTo('sec-cm')} title={g.note}>
        <span className={`ev-cd${cd === '今天' || cd === '明天' || cd === '進行中' ? ' soon' : ''}`}>{cd}</span>
        <span className="ev-main">
          <span className="ev-name">
            🌐 {g.name}
            <span className="muted">｜{GEO_TYPE_TEXT[g.type]}</span>
          </span>
          <span className="ev-when num">{geoWhenText(g)}</span>
        </span>
        <span className="ev-impact small">
          <span className="muted">不計分{g.note ? `｜${g.note}` : ''}</span>
        </span>
      </button>
    </li>
  );
}

function EventRow({
  r,
  regime,
  outlooks,
  now,
  onSelect,
}: {
  r: ScheduledRelease;
  regime: Regime;
  outlooks: Record<string, IndicatorOutlook>;
  now: Date;
  onSelect: (id: string) => void;
}) {
  const def = RELEASE_KINDS[r.kind];
  const range = eventRange(regime, r, outlooks);
  // PPI、PCE、台灣指標：權重 0，公布不會改變總分
  const unscored = def.indicators.every((id) => (INDICATOR_MAP[id]?.weight ?? 0) === 0);
  const flips = range && (range.best.regime !== range.now.regime || range.worst.regime !== range.now.regime);
  const cd = countdownText(releaseAt(r), now);
  // 參考事件（ADP、密大、零售銷售、財報季）：網站沒有對應指標，不可點
  const target = def.indicators[0];
  return (
    <li>
      <button
        type="button"
        className={`event${target ? '' : ' ev-ref'}`}
        onClick={target ? () => onSelect(target) : undefined}
        title={def.hint}
      >
        <span className={`ev-cd${cd === '今天' || cd === '明天' ? ' soon' : ''}`}>{cd}</span>
        <span className="ev-main">
          <span className="ev-name">
            {def.name}
            {r.note && <span className="muted">｜{r.note}</span>}
          </span>
          <span className="ev-when num">{whenText(r)}</span>
        </span>
        <span className={`ev-impact small${flips ? ' flip' : ''}`}>
          {range ? `${flips ? '⚠️ 可能翻轉結論：' : ''}${rangeText(range)}` : <span className="muted">{unscored ? `不計分${def.hint ? `｜${def.hint}` : ''}` : '—'}</span>}
        </span>
      </button>
    </li>
  );
}
