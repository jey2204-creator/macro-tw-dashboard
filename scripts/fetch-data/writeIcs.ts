import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { outlookPlain, rangeText } from '../../src/lib/outlookText';
import type { CalendarFile } from '../../src/shared/calendar';
import { addDays, todayInTaipei } from '../../src/shared/dates';
import { eventRange, outlooksFor } from '../../src/shared/outlook';
import { computeRegime, SIGNAL_LABEL } from '../../src/shared/regime';
import { RELEASE_KINDS, releaseAt, SCHEDULE, type ScheduledRelease } from '../../src/shared/schedule';
import type { SummaryFile } from '../../src/shared/types';

/**
 * 產生 public/data/macro-events.ics：美國重要總經公布（CPI、就業報告、GDP、FOMC）。
 * 手機行事曆以 webcal:// 訂閱後會自動同步；每次資料更新都重寫描述中的門檻與總分影響。
 * 每個事件公布前 30 分鐘提醒；Fed「升息滿 120 天」等不需公布就會改變判斷的日子也列入。
 */

const SITE = 'https://jey2204-creator.github.io/macro-tw-dashboard/';

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** RFC 5545：每行最多 75 octets，續行以空白開頭 */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function buildIcs(opts: {
  summary: SummaryFile | null;
  calendar: CalendarFile | null;
  now: Date;
  schedule?: readonly ScheduledRelease[];
}): string {
  const { now } = opts;
  const today = todayInTaipei(now);
  const regime = opts.summary ? computeRegime(opts.summary, today) : null;
  const outlooks = regime ? outlooksFor(regime, now, opts.calendar) : {};
  const from = addDays(today, -14);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//macro-tw-dashboard//US macro releases//ZH-TW',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:美國總經公布',
    'X-WR-TIMEZONE:Asia/Taipei',
    'X-PUBLISHED-TTL:PT6H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
  ];
  const dtstamp = stamp(now.toISOString());

  for (const r of opts.schedule ?? SCHEDULE) {
    const kind = RELEASE_KINDS[r.kind];
    if (kind.importance !== 'high' || r.date < from) continue;
    const at = releaseAt(r);
    const desc: string[] = [];
    const isNext = kind.indicators.some((id) => outlooks[id]?.release === r);
    if (regime && isNext) {
      const range = eventRange(regime, r, outlooks);
      desc.push(`目前總分 ${regime.score.toFixed(2)}（${SIGNAL_LABEL[regime.signal]}）`);
      if (range) desc.push(`這次公布可能讓總分落在：${rangeText(range)}`);
      for (const id of kind.indicators) {
        const o = outlooks[id];
        if (o && o.release === r) desc.push('', outlookPlain(o, regime.score));
      }
      desc.push('', `門檻依 ${today} 資料計算，會隨每次更新改寫。`);
    } else {
      desc.push('門檻會在前一次公布後計算並同步到這裡。');
    }
    desc.push(`來源：${kind.source}｜${SITE}`);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${r.kind}-${r.date}@macro-tw-dashboard`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${stamp(at)}`,
      'DURATION:PT15M',
      `SUMMARY:${esc(`🇺🇸 ${kind.name}${r.note ? `（${r.note}）` : ''}`)}`,
      `DESCRIPTION:${esc(desc.join('\n'))}`,
      `URL:${SITE}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${esc(`${kind.name} 30 分鐘後公布`)}`,
      'TRIGGER:-PT30M',
      'END:VALARM',
      'END:VEVENT',
    );
  }

  // Fed：升息／降息滿 120 天，不必開會判斷就會轉中性
  const fed = outlooks.fed?.policy?.holdNeutralFrom;
  if (fed) {
    const next = addDays(fed, 1);
    lines.push(
      'BEGIN:VEVENT',
      `UID:fed-window-${fed}@macro-tw-dashboard`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${fed.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${next.replace(/-/g, '')}`,
      `SUMMARY:${esc('Fed 利率變動滿 120 天：若期間沒再調整，判斷轉中性')}`,
      `DESCRIPTION:${esc(`規則：與 120 天前比較。${SITE}`)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function writeIcs(outDir: string, now = new Date()): Promise<number> {
  const summary = await readJson<SummaryFile>(path.join(outDir, 'summary.json'));
  const calendar = await readJson<CalendarFile>(path.join(outDir, 'calendar.json'));
  const ics = buildIcs({ summary, calendar, now });
  const file = path.join(outDir, 'macro-events.ics');
  await writeFile(`${file}.tmp`, ics);
  await rename(`${file}.tmp`, file);
  return (ics.match(/BEGIN:VEVENT/g) ?? []).length;
}
