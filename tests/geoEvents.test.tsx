// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIcs } from '../scripts/fetch-data/writeIcs';
import { EventsBar } from '../src/components/EventsBar';
import {
  GEO_EVENTS,
  GEO_MAX_PER_YEAR,
  geoByReactionDay,
  geoCountdown,
  geoProblems,
  geoReactions,
  geoSpanText,
  geoWhenText,
  upcomingGeo,
  type GeoEvent,
} from '../src/shared/geoEvents';
import type { Regime } from '../src/shared/regime';

const ev = (o: Partial<GeoEvent> & Pick<GeoEvent, 'id' | 'start' | 'react'>): GeoEvent => ({ type: 'summit', name: o.id, short: 'X', ...o });
const at = (s: string) => new Date(`${s}+08:00`);

afterEach(cleanup);

describe('重大事件清單（config/geo-events.json）', () => {
  it('清單本身沒有問題：日期格式、id 不重複、react 不早於 start、每年不超過上限', () => {
    expect(geoProblems()).toEqual([]);
    expect(GEO_EVENTS.find((e) => e.id === 'apec-2026')).toMatchObject({ start: '2026-11-18', end: '2026-11-19', react: '2026-11-20', short: 'APEC+川習' });
    expect(GEO_EVENTS.filter((e) => e.type === 'bilateral').map((e) => `${e.start} ${e.name} ${e.react}`)).toEqual([
      '2017-04-06 川習會（海湖莊園） 2017-04-10',
      '2017-07-08 川習會（漢堡） 2017-07-10',
      '2017-11-08 川習會（北京） 2017-11-09',
      '2018-12-01 川習會（布宜諾斯艾利斯） 2018-12-03',
      '2019-06-29 川習會（大阪） 2019-07-01',
      '2025-10-30 川習會（釜山） 2025-10-30',
      '2026-05-14 川習會（北京） 2026-05-14',
      '2026-09-23 川習會（華盛頓） 2026-09-25',
    ]);
    expect(GEO_EVENTS.find((e) => e.id === 'g20-2026')).toMatchObject({ start: '2026-12-14', end: '2026-12-15' });
    expect(GEO_EVENTS.every((e, i) => i === 0 || e.start >= GEO_EVENTS[i - 1]!.start)).toBe(true);
  });

  it('檢查抓得到寫錯的資料與超過每年上限', () => {
    expect(geoProblems([ev({ id: 'a', start: '2026-01-05', end: '2026-01-03', react: '2026-01-05' })])).toEqual(['a：end 早於 start']);
    expect(geoProblems([ev({ id: 'a', start: '2026-01-05', react: '2026-01-02' })])[0]).toBe('a：react 早於 start');
    expect(geoProblems([ev({ id: 'a', start: '2026-01-05', react: '2026-01-20' })])).toEqual(['a：react 離結束日超過 5 天']);
    expect(geoProblems([ev({ id: 'a', start: '2026-01-05', react: '2026-01-05', short: '這段文字超過八個字' })])).toEqual(['a：short 超過 8 個字']);
    const many = Array.from({ length: GEO_MAX_PER_YEAR + 1 }, (_, i) => ev({ id: `e${i}`, start: `2026-03-${String(i + 1).padStart(2, '0')}`, react: `2026-03-${String(i + 1).padStart(2, '0')}` }));
    expect(geoProblems(many)).toEqual([`2026 年 ${GEO_MAX_PER_YEAR + 1} 筆，超過上限 ${GEO_MAX_PER_YEAR}`]);
    expect(geoProblems([many[0]!, many[0]!])).toContain('e0：id 重複');
  });

  it('事件列：還沒結束且在天數內的才列；倒數含「進行中」', () => {
    const list = [
      ev({ id: 'past', start: '2026-11-03', react: '2026-11-04' }),
      ev({ id: 'ongoing', start: '2026-11-18', end: '2026-11-19', react: '2026-11-20' }),
      ev({ id: 'soon', start: '2026-12-01', react: '2026-12-01' }),
      ev({ id: 'far', start: '2026-12-14', end: '2026-12-15', react: '2026-12-16' }),
    ];
    expect(upcomingGeo(at('2026-11-19T10:00:00'), 14, list).map((e) => e.id)).toEqual(['ongoing', 'soon']);
    expect(upcomingGeo(at('2026-11-20T00:30:00'), 14, list).map((e) => e.id)).toEqual(['soon']);
    expect(upcomingGeo(at('2026-11-20T00:30:00'), 60, list).map((e) => e.id)).toEqual(['soon', 'far']);
    expect(geoCountdown(list[1]!, at('2026-11-19T10:00:00'))).toBe('進行中');
    expect(geoCountdown(list[1]!, at('2026-11-18T08:00:00'))).toBe('今天');
    expect(geoCountdown(list[1]!, at('2026-11-17T08:00:00'))).toBe('明天');
    expect(geoCountdown(list[3]!, at('2026-11-20T00:30:00'))).toBe('24天後');
  });

  it('日期文字', () => {
    expect(geoWhenText(ev({ id: 'a', start: '2026-12-14', end: '2026-12-15', react: '2026-12-16' }))).toBe('12/14（一）～12/15（二）');
    expect(geoWhenText(ev({ id: 'a', start: '2026-11-03', react: '2026-11-04' }))).toBe('11/03（二）');
    expect(geoSpanText(ev({ id: 'a', start: '2026-11-18', end: '2026-11-19', react: '2026-11-20' }))).toBe('11/18–19');
    expect(geoSpanText(ev({ id: 'a', start: '2026-12-30', end: '2027-01-02', react: '2027-01-04' }))).toBe('12/30–1/2');
    expect(geoSpanText(ev({ id: 'a', start: '2026-11-03', react: '2026-11-04' }))).toBe('11/3');
  });

  it('K 棒標記：react 當天或之後第一個交易日；還沒到、早於資料起點的不標；同日合併', () => {
    const tw = ['2026-11-04', '2026-11-05', '2026-11-09', '2026-11-10', '2026-11-19'];
    const list = [
      ev({ id: 'old', start: '2026-05-14', react: '2026-05-14' }),
      ev({ id: 'mid', start: '2026-11-03', react: '2026-11-04' }),
      ev({ id: 'weekend', start: '2026-11-07', react: '2026-11-07' }),
      ev({ id: 'same', start: '2026-11-09', react: '2026-11-09' }),
      ev({ id: 'apec', start: '2026-11-18', end: '2026-11-19', react: '2026-11-20' }),
    ];
    const m = geoByReactionDay(tw, list);
    expect([...m.keys()]).toEqual(['2026-11-04', '2026-11-09']);
    expect(m.get('2026-11-09')!.map((e) => e.id)).toEqual(['weekend', 'same']);
    expect(geoByReactionDay([...tw, '2026-11-20'], list).get('2026-11-20')!.map((e) => e.id)).toEqual(['apec']);
    expect(geoByReactionDay([], list).size).toBe(0);
  });
});

describe('重大事件一覽：台股反應', () => {
  it('當日對前一日、之後 5／20 日從反應日收盤起算；資料不夠或還沒發生＝null', () => {
    // 30 根：收盤 100、101、…、129；日期用連續平日近似
    const bars = Array.from({ length: 30 }, (_, i) => [`2026-01-${String(i + 1).padStart(2, '0')}`, 0, 0, 0, 100 + i] as const);
    const list = [
      ev({ id: 'first', start: '2026-01-01', react: '2026-01-01' }),
      ev({ id: 'mid', start: '2026-01-03', react: '2026-01-03' }),
      ev({ id: 'late', start: '2026-01-27', react: '2026-01-27' }),
      ev({ id: 'future', start: '2026-02-10', react: '2026-02-10' }),
    ];
    const r = geoReactions(bars, list);
    expect(r[0]).toMatchObject({ day: '2026-01-01', dayPct: null });
    expect(r[1]!.day).toBe('2026-01-03');
    expect(r[1]!.dayPct).toBeCloseTo((102 / 101 - 1) * 100, 6);
    expect(r[1]!.after5).toBeCloseTo((107 / 102 - 1) * 100, 6);
    expect(r[1]!.after20).toBeCloseTo((122 / 102 - 1) * 100, 6);
    expect(r[2]).toMatchObject({ day: '2026-01-27', after5: null, after20: null });
    expect(r[2]!.dayPct).not.toBeNull();
    expect(r[3]).toEqual({ event: list[3], day: null, dayPct: null, after5: null, after20: null });
  });
});

describe('重大事件：事件列與行事曆', () => {
  const regime = { score: 0, signal: 'neutral', items: [] } as unknown as Regime;

  it('事件列：和公布日程依時間混排，標 🌐、不計分', () => {
    const now = at('2026-12-10T09:00:00');
    const { container } = render(<EventsBar regime={regime} outlooks={{}} now={now} onSelect={() => {}} />);
    const row = screen.getByText(/G20 領袖峰會/).closest('button')!;
    expect(row.textContent).toContain('🌐');
    expect(row.textContent).toContain('4天後');
    expect(row.textContent).toContain('12/14（一）～12/15（二）');
    expect(row.textContent).toContain('不計分');
    // 依時間排序：12/10 CPI（台北 21:30）在 G20（12/14）之前
    const names = [...container.querySelectorAll('.ev-name')].map((n) => n.textContent ?? '');
    expect(names.findIndex((n) => n.includes('CPI'))).toBeLessThan(names.findIndex((n) => n.includes('G20')));
  });

  it('APEC 結束後不再出現在事件列', () => {
    render(<EventsBar regime={regime} outlooks={{}} now={at('2026-11-20T00:30:00')} onSelect={() => {}} />);
    expect(screen.queryByText(/APEC/)).toBeNull();
  });

  it('行事曆：全天事件、不設提醒；結束超過 14 天的不列', () => {
    const ics = buildIcs({ summary: null, calendar: null, now: at('2026-11-20T00:30:00') });
    const block = (uid: string) => ics.split('BEGIN:VEVENT').find((b) => b.includes(`UID:${uid}@`));
    const g20 = block('geo-g20-2026')!;
    expect(g20).toContain('DTSTART;VALUE=DATE:20261214');
    expect(g20).toContain('DTEND;VALUE=DATE:20261216');
    expect(g20).toContain('G20');
    expect(g20).not.toContain('VALARM');
    expect(block('geo-apec-2026')).toBeDefined();
    expect(block('geo-us-cn-truce-2027-01')).toContain('DTSTART;VALUE=DATE:20270110');
    expect(block('geo-trump-xi-beijing-2026')).toBeUndefined();
    expect(ics).toContain('X-WR-CALNAME:總經公布（美國・台灣）＋重大事件');
  });
});
