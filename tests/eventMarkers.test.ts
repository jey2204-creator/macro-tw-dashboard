import { describe, expect, it } from 'vitest';
import { eventLabel, eventStats, eventsByReactionDay, pastEvents, reactionDay, type MarkedEvent } from '../src/shared/eventMarkers';
import { RELEASE_HISTORY } from '../src/shared/releaseHistory';
import type { ScheduledRelease } from '../src/shared/schedule';
import type { Bar } from '../src/shared/types';

const flat = (d: string, c: number): Bar => [d, c, c, c, c];

describe('公布日標記', () => {
  it('反應日＝公布日之後第一個台股交易日（跨週末、連假順延；超出範圍為 null）', () => {
    const tw = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19'];
    expect(reactionDay('2026-10-14', tw)).toBe('2026-10-15'); // 週三 ET 公布 → 週四
    expect(reactionDay('2026-10-16', tw)).toBe('2026-10-19'); // 週五 → 下週一
    expect(reactionDay('2026-10-19', tw)).toBeNull();
    expect(reactionDay('2026-10-01', tw)).toBe('2026-10-13');
  });

  it('歷史清單與日程表合併去重，只取已發生的 CPI／就業／FOMC', () => {
    const schedule: ScheduledRelease[] = [
      { kind: 'cpi', date: '2026-10-14', timeET: '08:30', period: '2026-09-01' }, // 與歷史重複
      { kind: 'cpi', date: '2026-11-10', timeET: '08:30', period: '2026-10-01' }, // 未來
      { kind: 'fomc', date: '2026-10-28', timeET: '14:00', period: null },
      { kind: 'ppi', date: '2026-10-15', timeET: '08:30', period: '2026-09-01' }, // 不標
      { kind: 'jobs', date: '2026-10-30', timeET: '08:30', period: '2026-10-01' },
    ];
    const ev = pastEvents('2026-10-31', schedule);
    expect(ev.filter((e) => e.releaseDate === '2026-10-14' && e.kind === 'cpi')).toHaveLength(1);
    expect(ev.find((e) => e.releaseDate === '2026-11-10')).toBeUndefined();
    expect(ev.find((e) => e.releaseDate === '2026-10-15')).toBeUndefined();
    expect(ev.find((e) => e.releaseDate === '2026-10-28')?.kind).toBe('fomc');
    expect(ev.find((e) => e.releaseDate === '2026-10-30')).toMatchObject({ kind: 'jobs', period: '2026-10' });
    expect(ev.length).toBe(RELEASE_HISTORY.length + 2);
    expect(ev.every((e, i) => i === 0 || e.releaseDate >= ev[i - 1]!.releaseDate)).toBe(true);
  });

  it('歷史清單：2015 起每年 CPI／就業各 12 次（2025 政府停擺少 1 次）、FOMC 8 次＋3 次臨時', () => {
    const count = (kind: string, year: string) => RELEASE_HISTORY.filter((r) => r.kind === kind && r.date.startsWith(year) && !r.unscheduled).length;
    expect(count('cpi', '2019')).toBe(12);
    expect(count('jobs', '2019')).toBe(12);
    expect(count('fomc', '2019')).toBe(8);
    expect(count('cpi', '2025')).toBe(11);
    expect(RELEASE_HISTORY.filter((r) => r.unscheduled).map((r) => r.date)).toEqual(['2019-10-11', '2020-03-03', '2020-03-15']);
    const keys = RELEASE_HISTORY.map((r) => `${r.kind}@${r.date}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('事件統計：反應日與平常日分開計算、同日多事件各算一次', () => {
    const bars = [flat('2026-01-05', 100), flat('2026-01-06', 102), flat('2026-01-07', 101), flat('2026-01-08', 104), flat('2026-01-09', 104)];
    const events: MarkedEvent[] = [
      { kind: 'cpi', releaseDate: '2026-01-05', period: '2025-12' },
      { kind: 'fomc', releaseDate: '2026-01-05', period: null },
      { kind: 'jobs', releaseDate: '2026-01-07', period: '2025-12' },
    ];
    const byDay = eventsByReactionDay([...events, { kind: 'cpi', releaseDate: '2025-12-31', period: '2025-11' }], bars.map((b) => b[0]));
    // 早於資料起點（2025-12-31）的事件不標
    expect([...byDay.keys()]).toEqual(['2026-01-06', '2026-01-08']);
    const s = eventStats(bars, byDay, '2026-01-01');
    expect(s.kinds.cpi.n).toBe(1);
    expect(s.kinds.cpi.meanAbs).toBeCloseTo(2, 6);
    expect(s.kinds.fomc.meanAbs).toBeCloseTo(2, 6);
    expect(s.kinds.jobs.meanAbs).toBeCloseTo((3 / 101) * 100, 6);
    expect(s.kinds.jobs.bigPct).toBe(100);
    expect(s.normal.n).toBe(2);
    expect(s.normal.bigPct).toBe(0);
  });

  it('事件簡述', () => {
    expect(eventLabel({ kind: 'cpi', releaseDate: '2026-10-14', period: '2026-09' })).toBe('CPI（9 月）');
    expect(eventLabel({ kind: 'jobs', releaseDate: '2026-10-02', period: '2026-09' })).toBe('非農（9 月）');
    expect(eventLabel({ kind: 'fomc', releaseDate: '2026-09-16', period: null })).toBe('FOMC');
    expect(eventLabel({ kind: 'fomc', releaseDate: '2020-03-15', period: null, unscheduled: true })).toBe('FOMC（臨時）');
  });
});
