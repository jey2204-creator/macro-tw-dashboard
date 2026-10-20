import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsedPosts } from '../scripts/fetch-data/sources/factset';
import { writeFactsetEps } from '../scripts/fetch-data/writeFactsetEps';
import { epsRevisions, mergePosts, nextYearKey, type FactsetPost } from '../src/shared/factsetEps';

const post = (date: string, fwdPe: number, cy: Record<string, number>, url = `https://x/${date}`): FactsetPost => ({
  date, url, title: `S&P 500 Earnings Season Update: ${date}`, fwdPe, avg5: 19.8, avg10: 19.1, cy, quarterEst: {}, blended: null,
});

describe('FactSet 估值讀數', () => {
  it('合併：同網址以新的為準，依日期排序', () => {
    const a = post('2026-10-02', 19.5, { '2026': 33 });
    const b = post('2026-10-09', 19.2, { '2026': 33.1 });
    const b2 = { ...b, fwdPe: 19.3 };
    expect(mergePosts([b, a], [b2]).map((p) => [p.date, p.fwdPe])).toEqual([['2026-10-02', 19.5], ['2026-10-09', 19.3]]);
  });

  it('年度預估修正：最新一篇對 4 週前最後一篇逐年比較；資料不足 4 週回傳空', () => {
    const posts = [
      post('2026-09-11', 19.4, { '2026': 33.0, '2027': 16.5 }),
      post('2026-09-18', 19.3, { '2026': 33.2, '2027': 16.4 }),
      post('2026-10-02', 19.5, { '2026': 32.9, '2027': 15.6 }),
      post('2026-10-16', 19.0, { '2026': 32.8, '2027': 15.1 }),
    ];
    // 10/16 回推 28 天＝9/18：取 ≤ 9/18 的最後一篇（9/18）
    expect(epsRevisions(posts, 4)).toEqual([
      { year: '2026', now: 32.8, before: 33.2, beforeDate: '2026-09-18', change: expect.closeTo(-0.4, 6) },
      { year: '2027', now: 15.1, before: 16.4, beforeDate: '2026-09-18', change: expect.closeTo(-1.3, 6) },
    ]);
    expect(epsRevisions(posts.slice(2), 4)).toEqual([]);
    expect(nextYearKey(posts[3]!)).toBe('2027');
  });

  describe('寫檔', () => {
    let dir = '';
    afterEach(async () => {
      parsedPosts.clear();
      if (dir) await rm(dir, { recursive: true, force: true });
    });
    it('併入本次解析的文章；沒有新文章也沒有舊檔就不寫', async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'factset-'));
      expect(await writeFactsetEps(dir)).toBeNull();
      parsedPosts.set('https://x/2026-10-16', post('2026-10-16', 19.0, { '2026': 32.8 }, 'https://x/2026-10-16'));
      const out = (await writeFactsetEps(dir, new Date('2026-10-19T00:00:00Z')))!;
      expect(out.posts.map((p) => p.date)).toEqual(['2026-10-16']);
      parsedPosts.clear();
      parsedPosts.set('https://x/2026-10-23', post('2026-10-23', 18.9, { '2026': 32.9 }, 'https://x/2026-10-23'));
      const again = (await writeFactsetEps(dir))!;
      expect(again.posts.map((p) => p.date)).toEqual(['2026-10-16', '2026-10-23']);
      const onDisk = JSON.parse(await readFile(path.join(dir, 'factset-eps.json'), 'utf8'));
      expect(onDisk.posts.length).toBe(2);
    });
  });
});
