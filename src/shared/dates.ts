/** 日期工具：所有資料日期以 YYYY-MM-DD（市場當地日期）字串處理 */

const DAY_MS = 86_400_000;

const dtfCache = new Map<string, Intl.DateTimeFormat>();

/** 將 UNIX 秒數轉成指定 IANA 時區的當地日期 YYYY-MM-DD（正確處理夏令時間） */
export function toLocalDate(unixSeconds: number, timeZone: string): string {
  let fmt = dtfCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dtfCache.set(timeZone, fmt);
  }
  return fmt.format(new Date(unixSeconds * 1000));
}

export function parseDate(d: string): number {
  return Date.parse(`${d}T00:00:00Z`);
}

export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(d: string, days: number): string {
  return formatDate(parseDate(d) + days * DAY_MS);
}

/** b − a 的日曆天數 */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b) - parseDate(a)) / DAY_MS);
}

export function addMonths(d: string, months: number): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(day, lastDay));
  return formatDate(dt.getTime());
}

export function monthKey(d: string): string {
  return d.slice(0, 7);
}

/** ISO 週的週一日期，作為週 K 分組鍵 */
export function weekKey(d: string): string {
  const ms = parseDate(d);
  const dow = new Date(ms).getUTCDay(); // 0=週日
  const offset = (dow + 6) % 7; // 距週一天數
  return formatDate(ms - offset * DAY_MS);
}

/** 台北時間的今天日期 */
export function todayInTaipei(now: Date = new Date()): string {
  return toLocalDate(Math.floor(now.getTime() / 1000), 'Asia/Taipei');
}

/** ROC 民國日期 "115/09/01" → "2026-09-01" */
export function rocToIso(roc: string): string | null {
  const m = /^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/.exec(roc.trim());
  if (!m) return null;
  const y = Number(m[1]) + 1911;
  return `${y}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
}

/** 顯示用：ISO 時間 → 台北時間 "MM/DD HH:mm" */
export function formatTaipeiDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}
