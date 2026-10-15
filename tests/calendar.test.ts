import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseManual, updateCalendar } from '../scripts/fetch-data/calendar';
import { releaseLines } from '../src/lib/release';
import {
  actualFor,
  EVENT_DEF_MAP,
  mergeEvents,
  parseFfCalendar,
  parseFfValue,
  periodFor,
  periodStart,
  releasesByIndicator,
  viewEvent,
  type CalendarEvent,
  type CalendarFile,
} from '../src/shared/calendar';
import type { SummaryEntry, SummaryFile } from '../src/shared/types';

const entry = (id: string, tail: [string, number][]): SummaryEntry => ({
  id,
  source: { provider: 'fred', symbol: id, url: '' },
  status: 'ok',
  fetchedAt: '',
  lastSuccessAt: '',
  lastDate: tail.at(-1)?.[0] ?? null,
  closeOnly: true,
  partial: false,
  errors: [],
  tail,
});

/** 2025-09 → 2026-09 的指數：年增 3.7%、9 月季調月增 0.6% */
function makeSummary(): SummaryFile {
  const months = Array.from({ length: 13 }, (_, i) => {
    const y = 2025 + Math.floor((8 + i) / 12);
    const m = ((8 + i) % 12) + 1;
    return `${y}-${String(m).padStart(2, '0')}-01`;
  });
  const nsa: [string, number][] = months.map((d, i) => [d, i === 12 ? 103.7 : 100 + i * 0.25]);
  const sa: [string, number][] = months.map((d, i) => [d, i === 12 ? 101 * 1.006 : 100 + i * (1 / 11)]);
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-14T13:40:00Z',
    entries: { cpi: entry('cpi', nsa), cpi_sa: entry('cpi_sa', sa) },
  };
}

const FF_SAMPLE = [
  { title: 'CPI m/m', country: 'USD', date: '2026-10-14T08:30:00-04:00', impact: 'High', forecast: '0.6%', previous: '0.4%' },
  { title: 'CPI y/y', country: 'USD', date: '2026-10-14T08:30:00-04:00', impact: 'High', forecast: '3.6%', previous: '3.4%' },
  { title: 'Core CPI m/m', country: 'USD', date: '2026-10-14T08:30:00-04:00', impact: 'High', forecast: '0.2%', previous: '0.3%' },
  { title: 'CPI y/y', country: 'CAD', date: '2026-10-14T08:30:00-04:00', impact: 'High', forecast: '2.0%', previous: '2.1%' },
  { title: 'Non-Farm Employment Change', country: 'USD', date: '2026-11-06T08:30:00-05:00', impact: 'High', forecast: '45K', previous: '29K' },
  { title: 'Advance GDP q/q', country: 'USD', date: '2026-10-29T08:30:00-04:00', impact: 'High', forecast: '', previous: '2.2%' },
  { title: 'Crude Oil Inventories', country: 'USD', date: '2026-10-15T10:30:00-04:00', impact: 'High', forecast: '-1.2M', previous: '3.1M' },
];

describe('行事曆解析', () => {
  it('數值字串', () => {
    expect(parseFfValue('3.6%')).toBe(3.6);
    expect(parseFfValue('-0.1%')).toBe(-0.1);
    expect(parseFfValue('51K')).toBe(51);
    expect(parseFfValue('1.2M')).toBe(1200);
    expect(parseFfValue('')).toBeNull();
    expect(parseFfValue(undefined)).toBeNull();
  });

  it('參考期間：月資料為前一月，GDP 為前一季', () => {
    expect(periodFor('month', '2026-10-14')).toBe('2026-09');
    expect(periodFor('month', '2026-01-13')).toBe('2025-12');
    expect(periodFor('quarter', '2026-10-29')).toBe('2026-Q3');
    expect(periodFor('quarter', '2026-03-26')).toBe('2025-Q4');
    expect(periodStart('2026-Q3')).toBe('2026-07-01');
    expect(periodStart('2026-09')).toBe('2026-09-01');
  });

  it('只保留美國的目標數據，並推算期間', () => {
    const ev = parseFfCalendar(FF_SAMPLE);
    expect(ev.map((e) => e.key)).toEqual(['cpi_mom', 'cpi_yoy', 'core_mom', 'nfp', 'gdp']);
    const yoy = ev.find((e) => e.key === 'cpi_yoy')!;
    expect(yoy).toMatchObject({ releaseDate: '2026-10-14', period: '2026-09', forecast: 3.6, previous: 3.4 });
    expect(ev.find((e) => e.key === 'gdp')!).toMatchObject({ period: '2026-Q3', forecast: null });
    expect(() => parseFfCalendar({ error: 'x' })).toThrow();
  });
});

describe('合併歷史與手動輸入', () => {
  const base: CalendarEvent = {
    key: 'cpi_yoy', releaseDate: '2026-10-14', releaseAt: '2026-10-14T08:30:00-04:00',
    period: '2026-09', forecast: 3.6, previous: 3.4, source: 'forexfactory',
  };

  it('新抓到的空值不會蓋掉既有預期', () => {
    const out = mergeEvents([base], [{ ...base, forecast: null }], [], '2026-10-15');
    expect(out).toHaveLength(1);
    expect(out[0]!.forecast).toBe(3.6);
  });

  it('手動輸入優先，且之後自動值不覆蓋', () => {
    const m = mergeEvents([base], [], [{ key: 'cpi_yoy', releaseDate: '2026-10-14', forecast: 3.5 }], '2026-10-15');
    expect(m[0]).toMatchObject({ forecast: 3.5, source: 'manual', releaseAt: base.releaseAt });
    const again = mergeEvents(m, [{ ...base, forecast: 3.6 }], [], '2026-10-15');
    expect(again[0]!.source).toBe('manual');
  });

  it('只有手動輸入也能建立事件；過舊的事件會被移除', () => {
    const out = mergeEvents(
      [{ ...base, releaseDate: '2022-01-12' }],
      [],
      [{ key: 'core_yoy', releaseDate: '2026-10-14', forecast: 2.5 }],
      '2026-10-15',
    );
    expect(out.map((e) => e.key)).toEqual(['core_yoy']);
    expect(out[0]).toMatchObject({ period: '2026-09', releaseAt: null });
  });

  it('手動檔格式容錯', () => {
    expect(parseManual({ entries: [{ key: 'cpi_yoy', releaseDate: '2026-10-14', forecast: 3.6 }, { key: 'x' }] })).toHaveLength(1);
    expect(parseManual(null)).toEqual([]);
  });
});

describe('實績與預期比較', () => {
  const summary = makeSummary();
  const ev = parseFfCalendar(FF_SAMPLE);
  const after = new Date('2026-10-15T04:00:00Z');

  it('年增用未季調指數、月增用季調指數', () => {
    expect(actualFor(EVENT_DEF_MAP.cpi_yoy, '2026-09', summary)).toBeCloseTo(3.7, 6);
    expect(actualFor(EVENT_DEF_MAP.cpi_mom, '2026-09', summary)).toBeCloseTo(0.6, 6);
    expect(actualFor(EVENT_DEF_MAP.cpi_yoy, '2026-10', summary)).toBeNull();
  });

  it('高於預期／符合預期', () => {
    const yoy = viewEvent(EVENT_DEF_MAP.cpi_yoy, ev.find((e) => e.key === 'cpi_yoy')!, summary, after);
    expect(yoy).toMatchObject({ released: true, actual: 3.7, diff: 0.1, surprise: 'above' });
    const mom = viewEvent(EVENT_DEF_MAP.cpi_mom, ev.find((e) => e.key === 'cpi_mom')!, summary, after);
    expect(mom.surprise).toBe('inline');
  });

  it('公布前不顯示實績', () => {
    const before = new Date('2026-10-14T12:00:00Z');
    const v = viewEvent(EVENT_DEF_MAP.cpi_yoy, ev.find((e) => e.key === 'cpi_yoy')!, summary, before);
    expect(v).toMatchObject({ released: false, actual: null, surprise: null });
  });

  it('列上文字：最近一次公布（台北時間）＋實績＋預期', () => {
    const cal: CalendarFile = { schemaVersion: 1, generatedAt: '', feed: { status: 'ok', fetchedAt: '', errors: [] }, events: ev };
    const r = releasesByIndicator(cal, summary, after);
    const lines = releaseLines(r.cpi);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.head).toBe('10/14 20:30 公布');
    expect(lines[0]!.parts.map((p) => p.text)).toEqual(['年增 3.7%（預期 3.6% ▲+0.1pp）', '月增 0.6%（預期 0.6% 符合）']);
    expect(lines[0]!.parts[0]!.dir).toBe('up');
    // 核心 CPI 實績尚未有資料 → 待更新
    expect(releaseLines(r.core_cpi)[0]!.parts[0]!.text).toBe('月增 待更新（預期 0.2%）');
    // 尚未公布 → 下次
    expect(releaseLines(r.nfp)[0]).toMatchObject({ head: '下次 11/06 21:30', parts: [{ text: '新增 預期 +45k' }] });
  });
});

describe('updateCalendar', () => {
  it('抓取失敗時保留歷史並套用手動輸入，不丟例外', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cal-'));
    const manualFile = path.join(dir, 'manual.json');
    await writeFile(manualFile, JSON.stringify({ entries: [{ key: 'cpi_yoy', releaseDate: '2026-10-14', forecast: 3.6 }] }));
    const cal = await updateCalendar({
      outDir: dir,
      manualFile,
      fast: true,
      now: new Date('2026-10-15T04:00:00Z'),
      fetchImpl: async () => new Response('err', { status: 503 }),
    });
    expect(cal.feed.status).toBe('error');
    expect(cal.events).toHaveLength(1);
    const saved = JSON.parse(await readFile(path.join(dir, 'calendar.json'), 'utf8')) as CalendarFile;
    expect(saved.events[0]!.forecast).toBe(3.6);
  });

  it('成功時合併本週與下週', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cal-'));
    const cal = await updateCalendar({
      outDir: dir,
      manualFile: path.join(dir, 'none.json'),
      fast: true,
      now: new Date('2026-10-15T04:00:00Z'),
      fetchImpl: async (url) =>
        new Response(JSON.stringify(String(url).includes('nextweek') ? FF_SAMPLE.slice(4) : FF_SAMPLE.slice(0, 4))),
    });
    expect(cal.feed.status).toBe('ok');
    expect(cal.events.map((e) => e.key).sort()).toEqual(['core_mom', 'cpi_mom', 'cpi_yoy', 'gdp', 'nfp']);
  });
});
