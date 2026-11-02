/** 台北時間固定 UTC+8（無日光節約） */
const TPE_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

/**
 * 從 fromMs 到 toMs 之間「台北時間平日（週一～週五）」經過的小時數。
 * 排程只在平日跑，週末不更新是正常的，所以週末時數不計入。
 */
export function weekdayHoursBetween(fromMs: number, toMs: number): number {
  if (!(toMs > fromMs)) return 0;
  let total = 0;
  let t = fromMs + TPE_OFFSET_MS; // 換成「台北牆上時間」的毫秒
  const end = toMs + TPE_OFFSET_MS;
  while (t < end) {
    const dayStart = Math.floor(t / DAY_MS) * DAY_MS;
    const next = Math.min(dayStart + DAY_MS, end);
    const dow = new Date(dayStart).getUTCDay(); // 0=日 6=六
    if (dow !== 0 && dow !== 6) total += next - t;
    t = next;
  }
  return total / 3_600_000;
}
