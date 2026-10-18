import { describe, expect, it } from 'vitest';
import type { HttpOptions } from '../scripts/fetch-data/http';
import { fetchNaverKrForeign, parseNaverTrend } from '../scripts/fetch-data/sources/naverKr';
import type { Bar } from '../src/shared/types';

const trend = (ymd: string, f: string, p = '-1', i = '+1') => ({ bizdate: ymd, personalValue: p, foreignValue: f, institutionalValue: i });

/** 假的 Naver：依 bizdate 回傳；未列出的日期當作休市（三者皆 0）；fail 內的日期回 HTTP 500 */
function fakeNaver(values: Record<string, string>, fail: string[] = []) {
  const calls: string[] = [];
  const http: HttpOptions = {
    retries: 0,
    retryDelayMs: 0,
    fetchImpl: async (url) => {
      const ymd = new URL(url).searchParams.get('bizdate')!;
      const d = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`;
      calls.push(d);
      if (fail.includes(d)) return new Response('err', { status: 500 });
      const body = values[d] !== undefined ? trend(ymd, values[d]!) : trend(ymd, '0', '0', '0');
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
  return { http, calls };
}

describe('Naver 韓國外資', () => {
  it('解析帶正負號與千分位的億韓元；三者皆 0 為休市；日期不符就報錯', () => {
    expect(parseNaverTrend(trend('20261016', '+3,637', '-5,126', '-6,815'), '2026-10-16')).toBe(3637);
    expect(parseNaverTrend(trend('20261013', '-45,789'), '2026-10-13')).toBe(-45789);
    expect(parseNaverTrend(trend('20261009', '0', '0', '0'), '2026-10-09')).toBeNull();
    expect(() => parseNaverTrend(trend('20261010', '+1'), '2026-10-09')).toThrow(/日期不符/);
    expect(() => parseNaverTrend({ bizdate: '20261016', foreignValue: 'abc', personalValue: '1', institutionalValue: '1' }, '2026-10-16')).toThrow(
      /無法解析/,
    );
  });

  it('無快取：從今天往回補，時間用完就停（週末不查、休市日略過）', async () => {
    const { http, calls } = fakeNaver({ '2026-10-16': '+3,637', '2026-10-15': '-37,637', '2026-10-13': '-45,789' });
    let t = 0;
    const res = await fetchNaverKrForeign(null, '2026-10-18', http, true, {
      budgetSec: 4,
      clock: () => (t += 1000) - 1000,
    });
    // 10/18、10/17 是週末不查；10/14 未列出＝休市
    expect(calls[0]).toBe('2026-10-16');
    expect(calls).not.toContain('2026-10-17');
    expect(res.bars.map((b) => [b[0], b[4]])).toEqual([
      ['2026-10-13', -45789],
      ['2026-10-15', -37637],
      ['2026-10-16', 3637],
    ]);
    expect(res.incremental).toBe(true);
    expect(res.closeOnly).toBe(true);
  });

  it('有快取：重抓最近 14 天（覆蓋修正值），再從最早一天往前補；遇錯即停不留缺洞', async () => {
    const cached: Bar[] = [
      ['2026-09-21', -1500, -1500, -1500, -1500],
      ['2026-10-13', -45000, -45000, -45000, -45000],
      ['2026-10-16', 3204, 3204, 3204, 3204],
    ];
    const { http, calls } = fakeNaver(
      { '2026-10-16': '+3,637', '2026-10-13': '-45,789', '2026-10-08': '-20,704', '2026-10-07': '-26,188', '2026-09-18': '-1,000' },
      ['2026-09-17'],
    );
    const res = await fetchNaverKrForeign(cached, '2026-10-16', http, true, { budgetSec: 999 });
    const got = Object.fromEntries(res.bars.map((b) => [b[0], b[4]]));
    expect(got['2026-10-16']).toBe(3637); // 修正值覆蓋 3204
    expect(got['2026-10-08']).toBe(-20704); // 最近 14 天內的缺洞也補上
    expect(calls[0]).toBe('2026-10-02'); // 最新段：最後一天往前 14 天起
    expect(got['2026-09-18']).toBe(-1000);
    // 回補段在 09/17 出錯就停，不會跳過它去查更早的日子
    expect(calls.at(-1)).toBe('2026-09-17');
    expect(calls.filter((d) => d < '2026-09-17')).toEqual([]);
  });

  it('全部失敗時丟出錯誤，讓管線保留快取', async () => {
    const { http } = fakeNaver({}, ['2026-10-16']);
    await expect(fetchNaverKrForeign(null, '2026-10-16', http, true, { budgetSec: 999 })).rejects.toThrow();
  });
});
