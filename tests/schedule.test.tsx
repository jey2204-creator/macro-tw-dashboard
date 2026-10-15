// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIcs, foldLine } from '../scripts/fetch-data/writeIcs';
import { EventsBar } from '../src/components/EventsBar';
import { IndicatorTable } from '../src/components/IndicatorTable';
import { buildRow } from '../src/lib/rows';
import { impactPieces, thresholdPieces } from '../src/lib/outlookText';
import { getIndicator } from '../src/shared/indicators';
import { eventRange, outlooksFor, scoreWith, withValue } from '../src/shared/outlook';
import { computeRegime } from '../src/shared/regime';
import {
  countdownText,
  nextReleaseFor,
  releaseAt,
  SCHEDULE,
  scheduleEndsSoon,
  upcomingReleases,
  whenText,
} from '../src/shared/schedule';
import { evaluateSignal } from '../src/shared/signals';
import type { SummaryFile } from '../src/shared/types';

const summary = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'tests/fixtures/summary-2026-10-06.json'), 'utf8'),
) as SummaryFile;
const NOW = new Date('2026-10-07T04:00:00Z'); // 台北 10/07 12:00
const regime = computeRegime(summary, '2026-10-07');
const outlooks = outlooksFor(regime, NOW);

afterEach(cleanup);

describe('官方公布日程', () => {
  it('美東時間換算台北時間，處理夏令時間（11/1 起冬令）', () => {
    expect(releaseAt({ date: '2026-10-14', timeET: '08:30' })).toBe('2026-10-14T12:30:00.000Z'); // 台北 20:30
    expect(releaseAt({ date: '2026-11-10', timeET: '08:30' })).toBe('2026-11-10T13:30:00.000Z'); // 台北 21:30
    expect(releaseAt({ date: '2026-10-28', timeET: '14:00' })).toBe('2026-10-28T18:00:00.000Z'); // 台北 10/29 02:00
    expect(releaseAt({ date: '2026-12-09', timeET: '14:00' })).toBe('2026-12-09T19:00:00.000Z'); // 台北 12/10 03:00
  });

  it('日程依時間排序，且每類都有未來日期', () => {
    const times = SCHEDULE.map((r) => releaseAt(r));
    expect([...times].sort()).toEqual(times);
    for (const id of ['cpi', 'core_cpi', 'ppi', 'core_ppi', 'pce', 'core_pce', 'nfp', 'unrate', 'gdp', 'fed', 'gdpnow']) {
      expect(nextReleaseFor(id, NOW), id).not.toBeNull();
    }
  });

  it('下次公布：已過的不算，顯示台北時間與星期', () => {
    const after = new Date('2026-10-15T14:19:00Z'); // 台北 10/15 22:19，CPI 10/14 已公布
    const cpi = nextReleaseFor('cpi', after)!;
    expect(cpi.date).toBe('2026-11-10');
    expect(whenText(cpi)).toBe('11/10（二）21:30');
    expect(countdownText(releaseAt(cpi), after)).toBe('26天後');
    expect(whenText(nextReleaseFor('fed', after)!)).toBe('10/29（四）02:00');
    expect(nextReleaseFor('nfp', after)!.date).toBe('2026-11-06');
    expect(nextReleaseFor('gdp', after)!.note).toBe('Q3 初值');
    // PPI（BLS 2026-10-15 查證）：10 月數據 11/13 公布，冬令時間台北 21:30
    const ppi = nextReleaseFor('ppi', after)!;
    expect(ppi).toMatchObject({ kind: 'ppi', date: '2026-11-13', period: '2026-10-01' });
    expect(whenText(ppi)).toBe('11/13（五）21:30');
    // PCE（BEA 2026-10-16 查證）：9 月數據 10/29 與 Q3 GDP 初值同日，夏令時間台北 20:30
    const pce = nextReleaseFor('core_pce', after)!;
    expect(pce).toMatchObject({ kind: 'pce', date: '2026-10-29', period: '2026-09-01' });
    expect(whenText(pce)).toBe('10/29（四）20:30');
  });

  it('本週事件與日程到期提醒', () => {
    const list = upcomingReleases(NOW, 14).map((r) => `${r.kind}:${r.date}`);
    expect(list).toContain('cpi:2026-10-14');
    expect(list).not.toContain('fomc:2026-10-28');
    // GDPNow 清單只到 12/23
    expect(scheduleEndsSoon('gdpnow', new Date('2026-12-01T00:00:00Z'))).toBe('2026-12-23');
    expect(scheduleEndsSoon('cpi', new Date('2026-12-01T00:00:00Z'))).toBeNull();
  });
});

describe('翻轉門檻（真實資料 2026-10-06）', () => {
  it('門檻區間的邊界值經網站規則驗證', () => {
    for (const id of ['cpi', 'core_cpi', 'nfp', 'unrate', 'gdp', 'gdpnow']) {
      const o = outlooks[id]!;
      const ev = regime.evals.find((e) => e.def.id === id)!;
      expect(o.bands, id).not.toBeNull();
      for (const b of o.bands!) {
        for (const x of [b.lo, b.hi]) {
          if (x === null) continue;
          expect(evaluateSignal(ev.def, withValue(ev.points, o.release.period!, x)).signal, `${id} ${x}`).toBe(b.signal);
        }
      }
    }
  });

  it('核心 CPI：年增率門檻', () => {
    expect(outlooks.core_cpi!.bands!.map((b) => [b.signal, b.lo === null ? null : +b.lo.toFixed(2), b.hi === null ? null : +b.hi.toFixed(2)])).toEqual([
      ['bull', null, 2.36],
      ['neutral', 2.37, 2.76],
      ['bear', 2.77, null],
    ]);
    expect(thresholdPieces(outlooks.core_cpi!).map((p) => p.text)).toEqual(['年增 ≤ 2.36%', '2.37%～2.76%', '≥ 2.77%']);
  });

  it('Fed：降息／不變／升息情境與 120 天到期日', () => {
    const p = outlooks.fed!.policy!;
    expect(p).toEqual({ cut: 'neutral', hold: 'bear', hike: 'bear', holdNeutralFrom: '2027-01-15' });
  });

  it('非農：3 個月平均轉負的門檻', () => {
    expect(outlooks.nfp!.bands!.map((b) => b.signal)).toEqual(['bear', 'neutral']);
    expect(outlooks.nfp!.bands![0]!.hi).toBe(-163);
  });

  it('總分影響與實際重算一致', () => {
    const imp = scoreWith(regime, { core_cpi: 'bear' });
    const def = getIndicator('core_cpi');
    const expected = (regime.evals.reduce((s, e) => s + (e.counted ? e.contribution : 0), 0) - 1 * def.weight - def.weight) /
      regime.evals.reduce((s, e) => s + (e.counted ? e.def.weight : 0), 0);
    expect(imp.score).toBeCloseTo(expected, 10);
    expect(scoreWith(regime, {}).score).toBeCloseTo(regime.score, 10);
    const cpiEvent = SCHEDULE.find((r) => r.kind === 'cpi' && r.date === '2026-10-14')!;
    const range = eventRange(regime, cpiEvent, outlooks)!;
    expect(range.worst.regime).toBe('bear');
    expect(impactPieces(outlooks.core_cpi!, regime.score).find((p) => p.signal === 'bear')!.flips).toBe(true); // 單獨轉偏空就讓總分 −0.22
  });
});

describe('行事曆檔（.ics）', () => {
  const ics = buildIcs({ summary, calendar: null, now: NOW });

  it('格式：CRLF、每行 ≤ 75 bytes、含提醒與門檻', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(ics).toContain('UID:cpi-2026-10-14@macro-tw-dashboard');
    expect(ics).toContain('DTSTART:20261014T123000Z');
    expect(ics).toContain('TRIGGER:-PT30M');
    expect(ics).toContain('UID:fed-window-2027-01-15@macro-tw-dashboard');
    expect(ics).not.toContain('gdpnow-');
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('≥ 2.77% → 偏空');
  });

  it('折行不切斷多位元組字元', () => {
    const long = `DESCRIPTION:${'中文字'.repeat(40)}`;
    const folded = foldLine(long);
    expect(folded.replace(/\r\n /g, '')).toBe(long);
  });
});

describe('UI', () => {
  it('頁首事件列顯示倒數與總分區間', () => {
    render(<EventsBar regime={regime} outlooks={outlooks} now={NOW} onSelect={() => {}} />);
    expect(screen.getByText(/接下來 14 天公布/)).toBeTruthy();
    expect(screen.getByText('CPI 消費者物價')).toBeTruthy();
    expect(screen.getByText(/可能翻轉結論/)).toBeTruthy();
    expect(screen.getByText('訂閱行事曆').getAttribute('href')).toMatch(/^webcal:/);
  });

  it('指標列顯示下次公布與門檻', () => {
    const rows = regime.evals.map((ev) => buildRow(ev, summary));
    render(
      <IndicatorTable
        rows={rows}
        today="2026-10-07"
        selectedId={null}
        onSelect={() => {}}
        outlooks={outlooks}
        nowScore={regime.score}
        now={NOW}
      />,
    );
    expect(screen.getAllByText(/⏰ 下次 10\/14（三）20:30/).length).toBe(2);
    expect(screen.getByText('≥ 2.77% → 偏空')).toBeTruthy();
    expect(screen.getByText(/1\/15 起轉中性/)).toBeTruthy();
  });
});
