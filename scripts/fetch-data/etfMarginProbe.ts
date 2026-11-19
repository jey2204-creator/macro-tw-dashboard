/**
 * 探測（一次性）：融資維持率「不含 ETF」可不可行。
 *  1. 各日期：ETF（代號 00 開頭）佔融資市值比重、前幾大 ETF、敏感度（假設 ETF 自身維持率 r 時的不含 ETF 維持率）
 *  2. 最新日期：MI_MARGN 各 selectType 的彙總表是否隨類別變動（有沒有分類別的融資金額）
 * 結果寫到 probe-out/etf-margin-probe.json（由 workflow commit 回分支）。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { getJson, sleep, type HttpOptions } from './http';
import { parseMiIndexPrices, parseMiMargnAll } from './sources/twseChips';

const http: HttpOptions = { fetchImpl: (u, i) => fetch(u, i), retries: 2, retryDelayMs: 5000, timeoutMs: 60_000 };
const DATES = (process.argv[2] ?? '').split(',').filter(Boolean);
const TYPES = ['0099P', 'MS', '0049', '24', 'STOCK', 'ALLBUT0999'];
const R = [150, 167, 200, 250, 300];
const ymd = (d: string) => d.replace(/-/g, '');
const isEtf = (c: string) => /^00/.test(c);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function main() {
  const out: Any = { dates: [], types: [] };
  for (const d of DATES) {
    try {
      const mj = await getJson<Any>(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${ymd(d)}&selectType=ALL&response=json`, http);
      await sleep(2500);
      const pj = await getJson<Any>(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd(d)}&type=ALLBUT0999&response=json`, http);
      await sleep(2500);
      const day = parseMiMargnAll(mj);
      const prices = parseMiIndexPrices(pj);
      if (!day || !prices) { out.dates.push({ d, note: '查無資料' }); continue; }
      const detail = mj.tables?.find((t: Any) => t.fields?.[0] === '代號');
      const names = new Map<string, string>((detail?.data ?? []).map((r: string[]) => [r[0].trim(), (r[1] ?? '').trim()]));
      let mvAll = 0, mvEtf = 0, nEtf = 0, nAll = 0, noPx = 0;
      const etfs: [string, number][] = [];
      for (const [code, lots] of day.lots) {
        const px = prices.get(code);
        if (!px) { noPx++; continue; }
        const mv = lots * 1000 * px;
        mvAll += mv; nAll++;
        if (isEtf(code)) { mvEtf += mv; nEtf++; etfs.push([code, mv]); }
      }
      etfs.sort((a, b) => b[1] - a[1]);
      const ratio = (mvAll / day.loanYuan) * 100;
      const sens: Record<string, number | null> = {};
      for (const r of R) {
        const den = day.loanYuan - mvEtf / (r / 100);
        sens[r] = den > 0 ? Math.round(((mvAll - mvEtf) / den) * 1000) / 10 : null;
      }
      const row: Any = {
        d, ratio: Math.round(ratio * 100) / 100, loanYi: Math.round(day.loanYuan / 1e8),
        mvAllYi: Math.round(mvAll / 1e8), mvEtfYi: Math.round(mvEtf / 1e8),
        etfSharePct: Math.round((mvEtf / mvAll) * 1000) / 10, nAll, nEtf, noPx, sens,
        top: etfs.slice(0, 8).map(([c, mv]) => `${c} ${names.get(c) ?? ''} ${Math.round(mv / 1e8)}億`),
      };
      if (d === DATES[DATES.length - 1]) {
        row.tables = (mj.tables ?? []).map((t: Any) => ({ title: t.title, fields: t.fields, groups: t.groups, n: t.data?.length, head: t.data?.slice(0, 3) }));
        row.priceFields = (pj.tables ?? []).filter((t: Any) => t.fields?.includes('證券代號')).map((t: Any) => t.fields);
      }
      out.dates.push(row);
      console.log(`${d} ratio=${row.ratio} etfShare=${row.etfSharePct}% sens=${JSON.stringify(sens)}`);
    } catch (e) {
      out.dates.push({ d, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const last = DATES[DATES.length - 1];
  for (const t of TYPES) {
    try {
      const j = await getJson<Any>(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${ymd(last)}&selectType=${t}&response=json`, http);
      out.types.push({ t, stat: j.stat, tables: (j.tables ?? []).map((x: Any) => ({ title: x.title, fields: x.fields, n: x.data?.length, head: x.data?.slice(0, 3) })) });
    } catch (e) {
      out.types.push({ t, error: e instanceof Error ? e.message : String(e) });
    }
    await sleep(2500);
  }
  await mkdir('probe-out', { recursive: true });
  await writeFile('probe-out/etf-margin-probe.json', JSON.stringify(out, null, 1));
}
main();
