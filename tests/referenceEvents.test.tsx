// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildIcs } from '../scripts/fetch-data/writeIcs';
import { EventsBar } from '../src/components/EventsBar';
import type { Regime } from '../src/shared/regime';
import { RELEASE_KINDS, SCHEDULE, upcomingReleases, whenText, type ReleaseKind } from '../src/shared/schedule';

afterEach(cleanup);

const at = (s: string) => new Date(`${s}+08:00`);
const regime = { score: 0, signal: 'neutral', items: [] } as unknown as Regime;
const REF: ReleaseKind[] = ['adp', 'umich', 'retail', 'earnings'];

describe('參考事件（ADP、密大初值、零售銷售、財報季）', () => {
  it('沒有對應指標、標 reference，且都在平日', () => {
    for (const k of REF) {
      expect(RELEASE_KINDS[k].indicators).toEqual([]);
      expect(RELEASE_KINDS[k].reference).toBe(true);
      expect(RELEASE_KINDS[k].hint).toBeTruthy();
      const rows = SCHEDULE.filter((r) => r.kind === k);
      expect(rows.length).toBeGreaterThanOrEqual(5);
      for (const r of rows) expect([1, 2, 3, 4, 5]).toContain(new Date(`${r.date}T12:00:00Z`).getUTCDay());
    }
  });

  it('ADP 在同月就業報告之前；密大初值在週五', () => {
    const jobs = SCHEDULE.filter((r) => r.kind === 'jobs');
    for (const a of SCHEDULE.filter((r) => r.kind === 'adp')) {
      const j = jobs.find((x) => x.period === a.period);
      expect(j, a.date).toBeTruthy();
      expect(a.date < j!.date).toBe(true);
    }
    for (const u of SCHEDULE.filter((r) => r.kind === 'umich')) expect(new Date(`${u.date}T12:00:00Z`).getUTCDay()).toBe(5);
  });

  it('台北時間：ADP 冬令 21:15、密大 23:00、財報季 19:45', () => {
    const find = (k: ReleaseKind, d: string) => SCHEDULE.find((r) => r.kind === k && r.date === d)!;
    expect(whenText(find('adp', '2026-12-02'))).toBe('12/02（三）21:15');
    expect(whenText(find('umich', '2026-12-04'))).toBe('12/04（五）23:00');
    expect(whenText(find('retail', '2026-12-16'))).toBe('12/16（三）21:30');
    expect(whenText(find('earnings', '2027-01-14'))).toBe('01/14（四）19:45');
  });

  it('事件列：出現在 14 天內、不計分＋一句說明、點了不會選指標', () => {
    const now = at('2026-11-27T09:00:00');
    expect(upcomingReleases(now, 14).map((r) => r.kind)).toEqual(expect.arrayContaining(['adp', 'umich', 'jobs']));
    const onSelect = vi.fn();
    render(<EventsBar regime={regime} outlooks={{}} now={now} onSelect={onSelect} />);
    const row = screen.getByText(/ADP 就業（小非農）/).closest('button')!;
    expect(row.className).toContain('ev-ref');
    expect(row.textContent).toContain('不計分｜');
    expect(row.textContent).toContain('12/02（三）21:15');
    fireEvent.click(row);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText(/密大消費者信心／通膨預期/).closest('button')!.textContent).toContain('初值');
    fireEvent.click(screen.getByText(/就業報告（非農／失業率）/).closest('button')!);
    expect(onSelect).toHaveBeenCalledWith('nfp');
  });

  it('行事曆：列入、不設提醒', () => {
    const ics = buildIcs({ summary: null, calendar: null, now: at('2026-11-27T09:00:00') });
    const block = (uid: string) => ics.split('BEGIN:VEVENT').find((b) => b.includes(`UID:${uid}@`));
    for (const uid of ['adp-2026-12-02', 'umich-2026-12-04', 'retail-2026-12-16', 'earnings-2027-01-14']) {
      const b = block(uid);
      expect(b, uid).toBeTruthy();
      expect(b).not.toContain('BEGIN:VALARM');
    }
    expect(block('cpi-2026-12-10')).toContain('BEGIN:VALARM');
  });
});
