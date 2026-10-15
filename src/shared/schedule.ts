import { daysBetween, todayInTaipei } from './dates';

/**
 * 美國總經數據官方公布日程（下次公布日、倒數、本週事件、行事曆檔）。
 *
 * 來源（2026-10-15 查證，官方網站公布的排程）：
 *  - CPI、就業報告（非農＋失業率）：BLS https://www.bls.gov/schedule/news_release/cpi.htm、empsit.htm
 *  - GDP：BEA https://www.bea.gov/news/schedule/full（2027 年見 next-year）
 *  - FOMC：Fed https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm（會議日為暫定，前一次會議確認）
 *  - GDPNow：Atlanta Fed https://www.atlantafed.org/cqer/research/gdpnow（只公布到年底，約每月更新一次清單）
 *
 * 時間一律為**美東當地時間**，換算台北時間時自動處理夏令時間
 * （2026-11-01 起冬令：08:30 ET = 台北 21:30；14:00 ET = 台北 03:00）。
 *
 * 每年 10 月左右官方會公布隔年日程；GDPNow 清單較短，到期前 UI 會顯示「日程待更新」。
 */

export type ReleaseKind = 'cpi' | 'jobs' | 'gdp' | 'fomc' | 'gdpnow';

export interface ReleaseKindDef {
  kind: ReleaseKind;
  /** 顯示名稱 */
  name: string;
  /** 受影響的指標 id（會改變這些指標的判斷） */
  indicators: string[];
  /** 重要性：high 會出現在頁首事件列的醒目位置並加入行事曆提醒 */
  importance: 'high' | 'low';
  source: string;
}

export const RELEASE_KINDS: Record<ReleaseKind, ReleaseKindDef> = {
  cpi: { kind: 'cpi', name: 'CPI 消費者物價', indicators: ['cpi', 'core_cpi'], importance: 'high', source: 'BLS' },
  jobs: { kind: 'jobs', name: '就業報告（非農／失業率）', indicators: ['nfp', 'unrate'], importance: 'high', source: 'BLS' },
  gdp: { kind: 'gdp', name: 'GDP', indicators: ['gdp'], importance: 'high', source: 'BEA' },
  fomc: { kind: 'fomc', name: 'FOMC 利率決議', indicators: ['fed'], importance: 'high', source: 'Federal Reserve' },
  gdpnow: { kind: 'gdpnow', name: 'GDPNow 更新', indicators: ['gdpnow'], importance: 'low', source: 'Atlanta Fed' },
};

export interface ScheduledRelease {
  kind: ReleaseKind;
  /** 美東公布日 YYYY-MM-DD */
  date: string;
  /** 美東時間 HH:mm */
  timeET: string;
  /** 資料期間：月 YYYY-MM-01、季 YYYY-MM-01（季初），FOMC 為 null */
  period: string | null;
  /** 補充說明，例如「初值」 */
  note?: string;
  /** 時間為約略（GDPNow 通常在來源數據公布後數小時內更新） */
  approx?: boolean;
}

const m = (y: number, mo: number) => `${y}-${String(mo).padStart(2, '0')}-01`;

/** [公布日, 參考月份] */
const CPI: [string, string][] = [
  ['2026-10-14', m(2026, 9)],
  ['2026-11-10', m(2026, 10)],
  ['2026-12-10', m(2026, 11)],
  ['2027-01-13', m(2026, 12)],
  ['2027-02-11', m(2027, 1)],
  ['2027-03-10', m(2027, 2)],
  ['2027-04-13', m(2027, 3)],
  ['2027-05-12', m(2027, 4)],
  ['2027-06-10', m(2027, 5)],
  ['2027-07-14', m(2027, 6)],
  ['2027-08-11', m(2027, 7)],
  ['2027-09-14', m(2027, 8)],
  ['2027-10-14', m(2027, 9)],
  ['2027-11-10', m(2027, 10)],
  ['2027-12-10', m(2027, 11)],
];

const JOBS: [string, string][] = [
  ['2026-11-06', m(2026, 10)],
  ['2026-12-04', m(2026, 11)],
  ['2027-01-08', m(2026, 12)],
  ['2027-02-05', m(2027, 1)],
  ['2027-03-05', m(2027, 2)],
  ['2027-04-02', m(2027, 3)],
  ['2027-05-07', m(2027, 4)],
  ['2027-06-04', m(2027, 5)],
  ['2027-07-02', m(2027, 6)],
  ['2027-08-06', m(2027, 7)],
  ['2027-09-03', m(2027, 8)],
  ['2027-10-08', m(2027, 9)],
  ['2027-11-05', m(2027, 10)],
  ['2027-12-03', m(2027, 11)],
];

/** [公布日, 季初, 初值／修正／確定] */
const GDP: [string, string, string][] = [
  ['2026-10-29', m(2026, 7), 'Q3 初值'],
  ['2026-11-25', m(2026, 7), 'Q3 修正值'],
  ['2026-12-23', m(2026, 7), 'Q3 確定值'],
  ['2027-01-28', m(2026, 10), 'Q4 初值'],
  ['2027-02-25', m(2026, 10), 'Q4 修正值'],
  ['2027-03-31', m(2026, 10), 'Q4 確定值'],
  ['2027-04-29', m(2027, 1), 'Q1 初值'],
  ['2027-05-27', m(2027, 1), 'Q1 修正值'],
  ['2027-06-25', m(2027, 1), 'Q1 確定值'],
  ['2027-07-29', m(2027, 4), 'Q2 初值'],
  ['2027-08-25', m(2027, 4), 'Q2 修正值'],
  ['2027-09-30', m(2027, 4), 'Q2 確定值'],
  ['2027-10-28', m(2027, 7), 'Q3 初值'],
  ['2027-11-24', m(2027, 7), 'Q3 修正值'],
  ['2027-12-22', m(2027, 7), 'Q3 確定值'],
];

/** FOMC 會議第二天（14:00 ET 公布決議）；* 為附經濟預測（SEP）的會議 */
const FOMC: [string, boolean][] = [
  ['2026-10-28', false],
  ['2026-12-09', true],
  ['2027-01-27', false],
  ['2027-03-17', true],
  ['2027-04-28', false],
  ['2027-06-09', true],
  ['2027-07-28', false],
  ['2027-09-15', true],
  ['2027-10-27', false],
  ['2027-12-08', true],
];

/** GDPNow 更新日（Atlanta Fed 公布的清單，只到年底）：[日期, 時間, 預估的季度] */
const GDPNOW: [string, string, string, string?][] = [
  ['2026-10-15', '10:00', m(2026, 7)],
  ['2026-10-20', '08:30', m(2026, 7)],
  ['2026-10-27', '10:00', m(2026, 7)],
  ['2026-10-28', '08:30', m(2026, 7), 'Q3 最終預估'],
  ['2026-10-29', '08:30', m(2026, 10), 'Q4 首次預估'],
  ['2026-11-02', '10:00', m(2026, 10)],
  ['2026-11-04', '10:00', m(2026, 10)],
  ['2026-11-09', '10:00', m(2026, 10)],
  ['2026-11-17', '10:00', m(2026, 10)],
  ['2026-11-18', '08:30', m(2026, 10)],
  ['2026-11-25', '10:00', m(2026, 10)],
  ['2026-12-01', '10:00', m(2026, 10)],
  ['2026-12-08', '10:00', m(2026, 10)],
  ['2026-12-09', '10:00', m(2026, 10)],
  ['2026-12-16', '10:00', m(2026, 10)],
  ['2026-12-17', '08:30', m(2026, 10)],
  ['2026-12-23', '10:00', m(2026, 10)],
];

export const SCHEDULE: ScheduledRelease[] = [
  ...CPI.map(([date, period]): ScheduledRelease => ({ kind: 'cpi', date, timeET: '08:30', period })),
  ...JOBS.map(([date, period]): ScheduledRelease => ({ kind: 'jobs', date, timeET: '08:30', period })),
  ...GDP.map(([date, period, note]): ScheduledRelease => ({ kind: 'gdp', date, timeET: '08:30', period, note })),
  ...FOMC.map(([date, sep]): ScheduledRelease => ({
    kind: 'fomc',
    date,
    timeET: '14:00',
    period: null,
    note: sep ? '含經濟預測（SEP）' : undefined,
  })),
  ...GDPNOW.map(([date, timeET, period, note]): ScheduledRelease => ({
    kind: 'gdpnow',
    date,
    timeET,
    period,
    note,
    approx: true,
  })),
].sort((a, b) => releaseAt(a).localeCompare(releaseAt(b)));

/** 指定日期美東的 UTC 偏移（小時，負值），自動處理夏令時間 */
export function nyOffsetHours(date: string): number {
  // 用當地正午判斷，避開 02:00 切換時刻
  const probe = new Date(`${date}T16:00:00Z`);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(probe)
    .find((p) => p.type === 'timeZoneName')?.value;
  const mm = name?.match(/GMT([+-]\d+)/);
  return mm ? Number(mm[1]) : -5;
}

/** 公布時間 ISO（UTC） */
export function releaseAt(r: Pick<ScheduledRelease, 'date' | 'timeET'>): string {
  const off = nyOffsetHours(r.date);
  const sign = off < 0 ? '-' : '+';
  const local = `${r.date}T${r.timeET}:00${sign}${String(Math.abs(off)).padStart(2, '0')}:00`;
  return new Date(local).toISOString();
}

/** 某指標最近一次已公布 */
export function lastReleaseFor(indicatorId: string, now: Date, schedule: readonly ScheduledRelease[] = SCHEDULE): ScheduledRelease | null {
  const t = now.getTime();
  return (
    schedule.filter((r) => RELEASE_KINDS[r.kind].indicators.includes(indicatorId) && Date.parse(releaseAt(r)) <= t).at(-1) ?? null
  );
}

/** 某指標的下一次公布（尚未到時間的第一筆） */
export function nextReleaseFor(indicatorId: string, now: Date, schedule: readonly ScheduledRelease[] = SCHEDULE): ScheduledRelease | null {
  const t = now.getTime();
  return (
    schedule.find((r) => RELEASE_KINDS[r.kind].indicators.includes(indicatorId) && Date.parse(releaseAt(r)) > t) ?? null
  );
}

/** now 之後 days 天內的公布（依時間排序） */
export function upcomingReleases(now: Date, days: number, schedule: readonly ScheduledRelease[] = SCHEDULE): ScheduledRelease[] {
  const t = now.getTime();
  const end = t + days * 86_400_000;
  return schedule.filter((r) => {
    const at = Date.parse(releaseAt(r));
    return at > t && at <= end;
  });
}

/** 某類日程最後一筆日期；距今少於 warnDays 天時 UI 提示「日程待更新」 */
export function scheduleEndsSoon(kind: ReleaseKind, now: Date, warnDays = 30, schedule: readonly ScheduledRelease[] = SCHEDULE): string | null {
  const last = schedule.filter((r) => r.kind === kind).at(-1);
  if (!last) return null;
  const today = todayInTaipei(now);
  return daysBetween(today, last.date) < warnDays ? last.date : null;
}

/** 台北時間 "MM/DD HH:mm" 與星期 */
export function taipeiParts(iso: string): { md: string; hm: string; dow: string; date: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const dowMap: Record<string, string> = { Sun: '日', Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六' };
  const hour = get('hour') === '24' ? '00' : get('hour');
  return {
    md: `${get('month')}/${get('day')}`,
    hm: `${hour}:${get('minute')}`,
    dow: dowMap[get('weekday')] ?? '',
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/** 倒數文字：今天／明天／N 天後（以台北日期計） */
export function countdownText(iso: string, now: Date): string {
  const d = daysBetween(todayInTaipei(now), taipeiParts(iso).date);
  if (d <= 0) return '今天';
  if (d === 1) return '明天';
  return `${d}天後`;
}

/** 顯示用：「11/10（二）21:30」 */
export function whenText(r: ScheduledRelease): string {
  const p = taipeiParts(releaseAt(r));
  return `${p.md}（${p.dow}）${p.hm}${r.approx ? ' 後' : ''}`;
}

