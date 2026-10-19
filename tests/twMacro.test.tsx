// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../scripts/fetch-data/http';
import {
  clearTwGovCache,
  csvLine,
  fetchTwGov,
  ndcIndicatorCsv,
  parseCbcMoney,
  parseMoeaBulletinList,
  parseMoeaBulletinValue,
  parseMoeaOrders,
  parseMofExports,
  parseNdcIndicators,
  parseNdcPmi,
  unzip,
} from '../scripts/fetch-data/sources/twGov';
import { buildIcs } from '../scripts/fetch-data/writeIcs';
import { EventsBar } from '../src/components/EventsBar';
import { IndicatorTable } from '../src/components/IndicatorTable';
import { formatChange, formatValue } from '../src/lib/format';
import { JUMP_TARGETS } from '../src/lib/jump';
import { buildRow } from '../src/lib/rows';
import { CATEGORY_ORDER, getIndicator, INDICATORS } from '../src/shared/indicators';
import { computeRegime } from '../src/shared/regime';
import { nextReleaseFor, RELEASE_KINDS, releaseAt, SCHEDULE, upcomingReleases, whenText } from '../src/shared/schedule';
import { infoReason, recentDirection, zoneText } from '../src/shared/signals';
import { closes, transformPoints, type Point } from '../src/shared/timeseries';
import type { Bar, SummaryFile } from '../src/shared/types';
import { monthlySeries } from './helpers';

afterEach(cleanup);
beforeEach(() => clearTwGovCache());

/** 測試用 ZIP（deflate），結構同國發會檔案：中央目錄 + 本地檔頭 */
function makeZip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(text, 'utf8');
    const comp = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

const NDC_CSV = [
  '﻿"Date","領先指標綜合指數","領先指標不含趨勢指數","同時指標綜合指數","同時指標不含趨勢指數","落後指標綜合指數","落後指標不含趨勢指數","景氣對策信號綜合分數","景氣對策信號"',
  '198301,12.0,100.1,12.5,101.0,13.0,99.0,-,-',
  '202606,135.35,103.31,138.50,105.72,134.89,102.96,41,紅',
  '202607,137.96,103.87,140.90,106.08,138.63,104.38,41,紅',
  '202608,140.58,104.40,143.36,106.47,142.33,105.70,41,紅',
].join('\r\n');

describe('台灣官方資料解析', () => {
  it('CSV 一行：雙引號與逗號', () => {
    expect(csvLine('"a,b","c""d",e')).toEqual(['a,b', 'c"d', 'e']);
  });

  it('國發會 ZIP：以表頭找出景氣指標與燈號，略過 schema 檔；分數不含「-」', () => {
    const zip = unzip(
      makeZip({ 'schema-景氣指標與燈號.csv': 'name,title\n"Date","Date"', '景氣指標與燈號.csv': NDC_CSV, 'manifest.csv': 'x' }),
    );
    const t = parseNdcIndicators(ndcIndicatorCsv(zip));
    expect(t.signal).toEqual([
      ['2026-06-01', 41, 41, 41, 41],
      ['2026-07-01', 41, 41, 41, 41],
      ['2026-08-01', 41, 41, 41, 41],
    ]);
    expect(t.leading[0]![0]).toBe('1983-01-01');
    expect(t.light.get('2026-08-01')).toBe('紅');
  });

  it('PMI、財政部出口（略過年合計列）、外銷訂單（民國年月）、央行（全形欄名）', () => {
    expect(parseNdcPmi('﻿Date,PMI,NMI\r\n202608,62.5,55.6\r\n202609,63.4,56.9')).toEqual([
      ['2026-08-01', 62.5, 62.5, 62.5, 62.5],
      ['2026-09-01', 63.4, 63.4, 63.4, 63.4],
    ]);
    const mof = parseMofExports(
      '﻿幣別,按美元計算(百萬美元)/ 總計,按美元計算(百萬美元)/ 1.活動物\n115年,1.0,2.0\n115年 8月,82381.100,1\n115年 9月,87222.162,1\n\n',
    );
    expect(mof.map((b) => [b[0], b[4]])).toEqual([
      ['2026-08-01', 82381.1],
      ['2026-09-01', 87222.162],
    ]);
    const orders = parseMoeaOrders(
      '﻿統計項目,資料期(民國年),統計值(美元),計量單位(美元),統計值(新台幣),計量單位(新台幣)\n外銷訂單金額,11507,97939,百萬美元,31543,新臺幣億元\n其他項目,11507,1,百萬美元,1,x',
    );
    expect(orders).toEqual([['2026-07-01', 97939, 97939, 97939, 97939]]);
    const money = parseCbcMoney(
      '﻿期間,a,貨幣總計數 -Ｍ１Ｂ-原始值,貨幣總計數 -Ｍ１Ｂ-年增率,貨幣總計數 -Ｍ２-原始值,貨幣總計數 -Ｍ２-年增率\n1987M05,1,1,-,1,-\n2026M08,1,30750789,6.65499,70677981,6.78887',
    );
    expect(money.gap).toEqual([['2026-08-01', -0.1339, -0.1339, -0.1339, -0.1339]]);
  });

  it('經濟部新聞稿：列表取 bull_id 與月份，內文取金額（億美元 → 百萬美元）', () => {
    const list = parseMoeaBulletinList(
      '<a href="../bulletin/Bulletin.aspx?kind=5&amp;html=1&amp;menu_id=6724&amp;bull_id=16911" title="x">115年8月外銷訂單統計</a>' +
        '<a href="../bulletin/Bulletin.aspx?kind=5&amp;html=1&amp;menu_id=6724">外銷訂單統計</a>' +
        '<a href="Bulletin.aspx?bull_id=16896">115年7月外銷訂單統計</a>',
    );
    expect(list).toEqual([
      { bullId: '16911', month: '2026-08-01' },
      { bullId: '16896', month: '2026-07-01' },
    ]);
    const html = '<div>1.與上月比較：8月外銷訂單<span>1,029.6</span>億美元，較上月增加50.2億美元</div>';
    expect(parseMoeaBulletinValue(html, '2026-08-01')).toBe(102960);
    expect(parseMoeaBulletinValue(html, '2026-09-01')).toBeNull();
  });
});

describe('抓取流程（假網路）', () => {
  const csv = (rows: string[]) => new Response(rows.join('\n'));
  const ordersCsv = [
    '﻿統計項目,資料期(民國年),統計值(美元),計量單位(美元),統計值(新台幣),計量單位(新台幣)',
    ...Array.from({ length: 30 }, (_, i) => {
      const y = 113 + Math.floor((i + 1) / 12);
      const mo = ((i + 1) % 12) + 1;
      return `外銷訂單金額,${y}${String(mo).padStart(2, '0')},${50000 + i * 1000},百萬美元,1,x`;
    }),
  ];

  it('開放平台 API 查下載網址；外銷訂單以新聞稿補上開放資料之後的月份', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      if (url.includes('data.gov.tw/api')) {
        return new Response(JSON.stringify({ result: { distribution: [{ resourceDownloadUrl: 'https://example.test/orders.csv' }] } }));
      }
      if (url === 'https://example.test/orders.csv') return csv(ordersCsv);
      if (url.endsWith('menu_id=6724')) {
        return new Response('<a href="Bulletin.aspx?kind=5&amp;html=1&amp;menu_id=6724&amp;bull_id=900">115年8月外銷訂單統計</a>');
      }
      if (url.endsWith('bull_id=900')) return new Response('8月外銷訂單1,029.6億美元');
      return new Response('not found', { status: 404 });
    };
    const res = await fetchTwGov('MOEA_ORDERS', { fetchImpl, retries: 0, retryDelayMs: 0 });
    expect(res.bars.at(-2)![0]).toBe('2026-07-01');
    expect(res.bars.at(-1)).toEqual(['2026-08-01', 102960, 102960, 102960, 102960]);
    expect(res.incremental).toBe(false);
    expect(calls[0]).toBe('https://data.gov.tw/api/v2/rest/dataset/6845');
  });

  it('API 失敗改用已知網址；新聞稿失敗仍回傳開放資料', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('data.gov.tw/api')) return new Response('down', { status: 503 });
      if (url === 'https://service.moea.gov.tw/EE520/opendata/b.csv') return csv(ordersCsv);
      return new Response('forbidden', { status: 403 });
    };
    const res = await fetchTwGov('MOEA_ORDERS', { fetchImpl, retries: 0, retryDelayMs: 0 });
    expect(res.bars.at(-1)![0]).toBe('2026-07-01');
  });

  it('解析筆數太少視為格式改變（丟錯，保留快取）', async () => {
    const fetchImpl: FetchLike = async (url) =>
      url.includes('data.gov.tw') ? new Response('{}') : new Response('﻿Date,PMI,NMI\n202609,63.4,56.9');
    await expect(fetchTwGov('NDC_PMI', { fetchImpl, retries: 0, retryDelayMs: 0 })).rejects.toThrow(/格式/);
  });
});

describe('區間、連續月數與單位', () => {
  const signal = getIndicator('tw_signal');
  const pts: Point[] = monthlySeries(2025, [30, 33, 36, 38, 39, 40, 41, 41, 41]);

  it('景氣燈號：紅燈連 6 個月；不同區間重新計算', () => {
    expect(zoneText(signal, pts)).toBe('紅燈（連 6 個月）');
    expect(zoneText(signal, [...pts, ['2025-10-01', 37]])).toBe('黃紅燈');
    expect(zoneText(signal, monthlySeries(2025, [16]))).toBe('藍燈');
    expect(zoneText(signal, monthlySeries(2025, [17, 22]))).toBe('黃藍燈（連 2 個月）');
    expect(zoneText(signal, monthlySeries(2025, [23, 31]))).toBe('綠燈（連 2 個月）');
  });

  it('分數與 pp 單位：數值、前期變化、近期、依據文字', () => {
    expect(formatValue(signal, 41)).toBe('41分');
    expect(formatChange(signal, 1, 2.5).main).toBe('+1分');
    expect(recentDirection(signal, pts).text).toBe('3月 +1分');
    expect(infoReason(signal, pts)).toBe('紅燈（連 6 個月），近3月變化 +1分');
    const gap = getIndicator('tw_m1b_m2');
    expect(formatValue(gap, -0.1339)).toBe('-0.13pp');
    expect(formatChange(gap, -0.06, null).main).toBe('-0.06pp');
    expect(infoReason(gap, monthlySeries(2026, [1.2, 0.5, 0.1, -0.05, -0.13]))).toBe('死亡交叉（連 2 個月），近3月 -0.63pp');
  });

  it('年增率型：依據文字不重複「年增 x%」（數值欄已有）', () => {
    const exp = getIndicator('tw_exports');
    const levels = monthlySeries(2024, [...Array(12).fill(100), 120, 130, 140, 150]);
    const yoy = transformPoints(exp, levels);
    expect(infoReason(exp, yoy)).toBe('成長（連 4 個月），近3月 +30.0pp');
  });
});

describe('台灣公布日程（台北時間）', () => {
  it('台北 16:00＝UTC 08:00；顯示台北時間與星期', () => {
    const r = SCHEDULE.find((x) => x.kind === 'tw_signal' && x.date === '2026-10-28')!;
    expect(releaseAt(r)).toBe('2026-10-28T08:00:00.000Z');
    expect(whenText(r)).toBe('10/28（三）16:00');
    const money = SCHEDULE.find((x) => x.kind === 'tw_money' && x.date === '2026-10-23')!;
    expect(whenText(money)).toBe('10/23（五）16:20');
  });

  it('每個台灣指標都有下次公布；PMI 為「最晚」日期', () => {
    const now = new Date('2026-10-18T16:50:00Z'); // 台北 10/19 00:50
    expect(nextReleaseFor('tw_orders', now)!.date).toBe('2026-10-20');
    expect(nextReleaseFor('tw_signal', now)!.period).toBe('2026-09-01');
    expect(nextReleaseFor('tw_exports', now)!.date).toBe('2026-11-09');
    expect(nextReleaseFor('tw_m1b_m2', now)!.date).toBe('2026-10-23');
    const pmi = nextReleaseFor('tw_pmi', now)!;
    expect([pmi.date, pmi.note]).toEqual(['2026-11-03', '最晚']);
    // 指標 id 與日程對得上
    for (const k of Object.values(RELEASE_KINDS)) for (const id of k.indicators) expect(getIndicator(id).id).toBe(id);
  });

  it('14 天內的事件含台灣；M1B／M2 為低重要性', () => {
    const now = new Date('2026-10-18T16:50:00Z');
    const kinds = upcomingReleases(now, 14).map((r) => r.kind);
    expect(kinds).toContain('tw_orders');
    expect(kinds).toContain('tw_signal');
    expect(RELEASE_KINDS.tw_money.importance).toBe('low');
  });
});

describe('UI 與行事曆', () => {
  const tail = (bars: Bar[]) => bars.map((b): [string, number] => [b[0], b[4]]);
  const mk = (id: string, bars: Bar[]) => ({
    id,
    source: { provider: 'tw_gov', symbol: 'X', url: '' },
    status: 'ok' as const,
    fetchedAt: '2026-10-19T00:00:00Z',
    lastSuccessAt: '2026-10-19T00:00:00Z',
    lastDate: bars.at(-1)![0],
    closeOnly: true,
    partial: false,
    errors: [],
    tail: tail(bars),
  });
  const bars = (vals: number[], start = 2025): Bar[] => monthlySeries(start, vals).map(([d, v]) => [d, v, v, v, v]);
  const summary: SummaryFile = {
    schemaVersion: 1,
    generatedAt: '2026-10-19T00:00:00Z',
    entries: {
      tw_signal: mk('tw_signal', bars([...Array(11).fill(30), 38, 39, 40, 40, 40, 40, 41, 41, 41], 2025)),
      tw_pmi: mk('tw_pmi', bars([...Array(9).fill(48), ...Array(12).fill(55)], 2025)),
    },
  };
  const now = new Date('2026-10-18T16:50:00Z');

  it('台灣景氣分類在美國總經之後，列上顯示燈號與連續月數，不計分', () => {
    expect(CATEGORY_ORDER.at(-1)).toBe('tw_macro');
    expect(INDICATORS.filter((d) => d.category === 'tw_macro').every((d) => d.weight === 0)).toBe(true);
    const regime = computeRegime(summary, '2026-10-19');
    const rows = regime.evals.filter((e) => e.def.category === 'tw_macro').map((ev) => buildRow(ev, summary));
    const { container } = render(<IndicatorTable rows={rows} today="2026-10-19" selectedId={null} onSelect={() => {}} now={now} />);
    expect(container.querySelector('#sec-grp-tw_macro')).not.toBeNull();
    expect(screen.getByText('紅燈（連 9 個月），近3月變化 +1分')).toBeTruthy();
    expect(screen.getByText(/擴張（連 12 個月）/)).toBeTruthy();
    expect(container.textContent).toContain('⏰ 下次 10/28（三）16:00');
    expect(container.textContent).toContain('國發會／中經院｜最晚');
    expect(JUMP_TARGETS.map((t) => t.id)).toContain('sec-grp-tw_macro');
  });

  it('事件列：台灣事件標「不計分」', () => {
    const regime = computeRegime(summary, '2026-10-19');
    const { container } = render(<EventsBar regime={regime} outlooks={{}} now={now} onSelect={() => {}} />);
    expect(container.textContent).toContain('台灣外銷訂單');
    expect(container.textContent).toContain('不計分');
  });

  it('.ics：台灣事件用台北時間、🇹🇼 標題、不設提醒', () => {
    const ics = buildIcs({ summary: null, calendar: null, now });
    const ev = ics.split('BEGIN:VEVENT').find((s) => s.includes('UID:tw_signal-2026-10-28'))!;
    expect(ev).toContain('DTSTART:20261028T080000Z');
    expect(ev.replace(/\r\n /g, '')).toContain('🇹🇼 台灣景氣燈號');
    expect(ev).not.toContain('VALARM');
    expect(ics).not.toContain('UID:tw_money-');
    expect(ics.replace(/\r\n /g, '')).toContain('X-WR-CALNAME:總經公布（美國・台灣）');
  });
});

describe('真實資料比對（2026-10-19 探測抓到的值）', () => {
  it('外銷訂單 8 月 1,029.6 億美元、年增 71.4%（新聞稿 71.4%）', () => {
    // 2025-08 開放資料 60,084 百萬美元（經濟部 b.csv）
    const pts = closes([
      ['2025-08-01', 60084, 60084, 60084, 60084],
      ['2026-08-01', 102960, 102960, 102960, 102960],
    ]);
    const yoy = transformPoints(getIndicator('tw_orders'), pts);
    expect(yoy.at(-1)![1].toFixed(1)).toBe('71.4');
  });
});

describe('規則說明', () => {
  it('台灣景氣：已回測（不寫待回測驗證）；其他參考型維持原說明', async () => {
    const { describeRule } = await import('../src/shared/signals');
    const tw = getIndicator('tw_pmi');
    expect(describeRule(tw.rule, tw)).toContain('回測：加進綜合分數沒有增量');
    const chips = getIndicator('net_foreign');
    expect(describeRule(chips.rule, chips)).toContain('待回測驗證');
  });
});
