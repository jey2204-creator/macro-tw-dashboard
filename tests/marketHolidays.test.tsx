// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildIcs } from '../scripts/fetch-data/writeIcs';
import { EventsBar } from '../src/components/EventsBar';
import { statusTags, type RowModel } from '../src/lib/rows';
import { GEO_EVENTS, geoProblems } from '../src/shared/geoEvents';
import { INDICATOR_MAP, INDICATORS } from '../src/shared/indicators';
import {
  closedWeekdaysBetween,
  closureNote,
  earlyCloseTaipei,
  holidayHint,
  holidayOn,
  holidayProblems,
  HOLIDAYS,
  holidaysEndSoon,
  holidaySpans,
  isTradingDay,
  marketOf,
  nextTradingDay,
  prevTradingDay,
  upcomingHolidays,
} from '../src/shared/marketHolidays';
import { evaluateIndicator, type Regime } from '../src/shared/regime';
import type { SummaryFile } from '../src/shared/types';

afterEach(cleanup);

const at = (s: string) => new Date(`${s}+08:00`);
const regime = { score: 0, signal: 'neutral', items: [] } as unknown as Regime;

/** 某年平日天數 − 公告休市天數＝交易日數 */
function tradingDays(market: 'us' | 'tw', year: number): number {
  let n = 0;
  for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += 86_400_000) if (isTradingDay(market, new Date(t).toISOString().slice(0, 10))) n += 1;
  return n;
}

describe('休市日清單（config/market-holidays.json）', () => {
  it('格式、平日、排序都沒問題', () => {
    expect(holidayProblems()).toEqual([]);
  });

  it('交易日數與官方公告一致：台股 2026＝243、2027＝242；美股 2026＝251、2027＝251', () => {
    expect(tradingDays('tw', 2026)).toBe(243);
    expect(tradingDays('tw', 2027)).toBe(242);
    expect(tradingDays('us', 2026)).toBe(251);
    expect(tradingDays('us', 2027)).toBe(251);
  });

  it('NYSE：每年 9～10 個休市日，感恩節在週四、隔天提早收盤', () => {
    for (const y of ['2026', '2027', '2028']) {
      const closed = HOLIDAYS.us.closed.filter((h) => h.date.startsWith(y));
      expect(closed.length).toBe(y === '2028' ? 9 : 10);
      const tg = closed.find((h) => h.name === '感恩節')!;
      expect(new Date(`${tg.date}T12:00:00Z`).getUTCDay()).toBe(4);
      const next = new Date(Date.parse(`${tg.date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      expect(HOLIDAYS.us.early!.some((e) => e.date === next)).toBe(true);
    }
  });

  it('春節合併成一段：2027 封關 2/1、開紅盤 2/11，2/2、2/3 僅結算交割', () => {
    const lny = holidaySpans('tw').find((s) => s.start === '2027-02-02')!;
    expect(lny).toMatchObject({ end: '2027-02-10', name: '農曆春節', days: 7, settle: ['2027-02-02', '2027-02-03'] });
    expect(prevTradingDay('tw', lny.start)).toBe('2027-02-01');
    expect(nextTradingDay('tw', lny.end)).toBe('2027-02-11');
    expect(holidayHint(lny)).toBe('封關 2/1、開紅盤 2/11；2/2、2/3 僅結算交割');
    const lny26 = holidaySpans('tw').find((s) => s.start === '2026-02-12')!;
    expect(lny26.end).toBe('2026-02-20');
    expect(nextTradingDay('tw', lny26.end)).toBe('2026-02-23');
  });

  it('隔著週末的兩個假日併成一段；單日假日各自一段', () => {
    const spans = holidaySpans('tw');
    expect(spans.find((s) => s.start === '2026-09-25')).toMatchObject({ end: '2026-09-28', name: '中秋節＋教師節', days: 2 });
    expect(spans.find((s) => s.start === '2026-12-25')).toMatchObject({ end: '2026-12-25', name: '行憲紀念日', days: 1 });
    expect(spans.find((s) => s.start === '2026-02-27')).toMatchObject({ end: '2026-02-27', days: 1 });
  });

  it('提早收盤的台北時間：冬令隔天 02:00、夏令隔天 01:00', () => {
    expect(earlyCloseTaipei('2026-11-27')).toBe('02:00');
    expect(earlyCloseTaipei('2028-07-03')).toBe('01:00');
  });

  it('清單快到期會提醒', () => {
    expect(holidaysEndSoon(at('2026-11-26T22:00:00'))).toEqual([]);
    expect(holidaysEndSoon(at('2027-11-20T09:00:00'))).toEqual([{ market: 'tw', through: '2027-12-31' }]);
  });
});

describe('台灣選舉進重大事件清單', () => {
  it('九合一 11/28（六），反應日 11/30（一）', () => {
    expect(geoProblems()).toEqual([]);
    const e = GEO_EVENTS.find((x) => x.id === 'tw-local-2026')!;
    expect(e).toMatchObject({ type: 'election', start: '2026-11-28', react: '2026-11-30' });
    expect(new Date(`${e.start}T12:00:00Z`).getUTCDay()).toBe(6);
    expect(isTradingDay('tw', e.react)).toBe(true);
  });
});

describe('事件列與行事曆', () => {
  it('14 天內：今天美股休市（感恩節）、明天提早收盤、九合一選舉', () => {
    const now = at('2026-11-26T22:14:00');
    expect(upcomingHolidays(now, 14).map((h) => `${h.market}-${h.kind}-${h.start}`)).toEqual(['us-closed-2026-11-26', 'us-early-2026-11-27']);
    const onSelect = vi.fn();
    render(<EventsBar regime={regime} outlooks={{}} now={now} onSelect={onSelect} />);
    const closed = screen.getByText(/美股休市/).closest('button')!;
    expect(closed.textContent).toContain('今天');
    expect(closed.textContent).toContain('感恩節');
    expect(closed.textContent).toContain('11/26（四）');
    expect(closed.textContent).toContain('不計分｜');
    const early = screen.getByText(/美股提早收盤/).closest('button')!;
    expect(early.textContent).toContain('明天');
    expect(early.textContent).toContain('台北隔天 02:00');
    fireEvent.click(closed);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText(/台灣九合一地方選舉/).closest('button')!.textContent).toContain('11/28（六）');
  });

  it('60 天內：12/25 美股、台股各一列', () => {
    render(<EventsBar regime={regime} outlooks={{}} now={at('2026-11-30T09:00:00')} onSelect={() => {}} />);
    fireEvent.click(screen.getByText('看 60 天'));
    const texts = (re: RegExp) => screen.getAllByText(re).map((el) => el.closest('button')!.textContent);
    expect(texts(/美股休市/)).toEqual([expect.stringContaining('聖誕節'), expect.stringContaining('元旦'), expect.stringContaining('馬丁路德金恩日')]);
    expect(texts(/台股休市/)).toEqual([expect.stringContaining('行憲紀念日'), expect.stringContaining('元旦')]);
    expect(texts(/美股提早收盤/)).toEqual([expect.stringContaining('聖誕夜')]);
  });

  it('連假進行中標「進行中」', () => {
    render(<EventsBar regime={regime} outlooks={{}} now={at('2027-02-05T09:00:00')} onSelect={() => {}} />);
    const row = screen.getByText(/台股休市/).closest('button')!;
    expect(row.textContent).toContain('進行中');
    expect(row.textContent).toContain('02/02（二）～02/10（三）');
  });

  it('.ics：全天事件、不設提醒；春節一筆涵蓋到 2/10', () => {
    const ics = buildIcs({ summary: null, calendar: null, now: at('2026-11-26T22:00:00'), schedule: [], geo: [] }).replace(/\r\n /g, '');
    expect(ics).not.toContain('BEGIN:VALARM');
    expect(ics).toContain('UID:hol-us-closed-2026-11-26@macro-tw-dashboard');
    expect(ics).toMatch(/UID:hol-tw-closed-2027-02-02@macro-tw-dashboard\r\nDTSTAMP:[^\r]+\r\nDTSTART;VALUE=DATE:20270202\r\nDTEND;VALUE=DATE:20270211/);
    expect(ics).toContain('SUMMARY:🇺🇸 美股提早收盤（感恩節翌日）');
    // 已結束超過 14 天的不列
    expect(ics).not.toContain('hol-tw-closed-2026-10-26');
  });
});

describe('休市標籤（closureNote）', () => {
  it('美股：感恩節當天與隔天台北白天都算休市，週五收盤後不算', () => {
    expect(closureNote('us', at('2026-11-26T22:14:00'))).toMatchObject({ when: 'today', name: '感恩節', date: '2026-11-26' });
    expect(closureNote('us', at('2026-11-27T08:00:00'))).toMatchObject({ when: 'today' });
    // 台北週五 15:00＝美東週五 02:00：最新美股仍是週三
    expect(closureNote('us', at('2026-11-27T15:00:00'))).toMatchObject({ when: 'prev', date: '2026-11-26' });
    // 提早收盤日：美東 13:00 後（台北週六 02:00）已有新收盤
    expect(closureNote('us', at('2026-11-28T02:30:00'))).toBeNull();
    expect(closureNote('us', at('2026-11-25T22:00:00'))).toBeNull();
  });

  it('台股：休市當天、連假中的週末、開紅盤當天盤中都標；收盤後不標', () => {
    expect(closureNote('tw', at('2026-12-25T10:00:00'))).toMatchObject({ when: 'today', name: '行憲紀念日' });
    expect(closureNote('tw', at('2026-12-26T10:00:00'))).toMatchObject({ when: 'prev', date: '2026-12-25' });
    expect(closureNote('tw', at('2026-12-28T09:30:00'))).toMatchObject({ when: 'prev' });
    expect(closureNote('tw', at('2026-12-28T14:00:00'))).toBeNull();
    expect(closureNote('tw', at('2026-11-26T22:14:00'))).toBeNull();
  });

  it('指標表：只有每日更新的台股、美股列會標「休市」', () => {
    expect(marketOf(INDICATOR_MAP.spx!)).toBe('us');
    expect(marketOf(INDICATOR_MAP.taiex!)).toBe('tw');
    expect(marketOf(INDICATOR_MAP.net_foreign!)).toBe('tw');
    expect(marketOf(INDICATOR_MAP.us10y!)).toBeNull();
    expect(marketOf(INDICATOR_MAP.tw_exports!)).toBeNull();
    const row = (id: string): RowModel =>
      ({ ev: { def: INDICATOR_MAP[id]!, stale: false }, entry: { status: 'ok', errors: [], partial: false, source: { provider: 'x' } } }) as unknown as RowModel;
    const now = at('2026-11-26T22:14:00');
    expect(statusTags(row('spx'), now).map((t) => t.text)).toEqual(['休市']);
    expect(statusTags(row('taiex'), now)).toEqual([]);
    expect(statusTags(row('us10y'), now)).toEqual([]);
    expect(statusTags(row('spx'))).toEqual([]);
  });
});

describe('連假不判過時（只限台股權重 0 的參考指標）', () => {
  const summaryWith = (id: string, lastDate: string): SummaryFile =>
    ({ generatedAt: '', entries: { [id]: { status: 'ok', errors: [], tail: [[lastDate, 1]], lastDate } } }) as unknown as SummaryFile;

  it('2027 春節：封關 2/1 → 2/10 共 9 天，中間 7 個休市平日', () => {
    expect(closedWeekdaysBetween('tw', '2027-02-01', '2027-02-10')).toBe(7);
    expect(closedWeekdaysBetween('tw', '2027-02-01', '2027-02-01')).toBe(0);
  });

  it('外資買賣超（權重 0、5 天）：春節期間不過時；平常超過 5 天仍過時', () => {
    const def = INDICATOR_MAP.net_foreign!;
    expect(def.weight).toBe(0);
    expect(evaluateIndicator(def, summaryWith('net_foreign', '2027-02-01'), '2027-02-10').stale).toBe(false);
    expect(evaluateIndicator(def, summaryWith('net_foreign', '2027-02-01'), '2027-02-11').stale).toBe(false);
    // 開紅盤後還是沒更新 → 2/17 起過時
    expect(evaluateIndicator(def, summaryWith('net_foreign', '2027-02-01'), '2027-02-17').stale).toBe(true);
    expect(evaluateIndicator(def, summaryWith('net_foreign', '2026-11-18'), '2026-11-26').stale).toBe(true);
  });

  it('有計分的指標不受影響：扣不扣休市日，判定方式都和原本一樣', () => {
    const scoredDaily = INDICATORS.filter((d) => d.weight > 0 && marketOf(d) !== null).map((d) => d.id);
    expect(scoredDaily).toEqual(expect.arrayContaining(['taiex', 'tpex', 'spx', 'nasdaq', 'sox']));
    for (const id of ['taiex', 'tpex']) {
      // 原規則：超過 maxAgeDays（日曆天）就過時——春節期間照舊
      expect(evaluateIndicator(INDICATOR_MAP[id]!, summaryWith(id, '2027-02-01'), '2027-02-10').stale).toBe(true);
    }
    expect(holidayOn('us', '2026-11-26')?.name).toBe('感恩節');
  });
});
