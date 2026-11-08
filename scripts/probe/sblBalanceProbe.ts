/**
 * 探測證交所「借券餘額」（有價證券借貸，SBL）資料源：印出各候選端點的 stat、欄位、前 2 列、列數與合計。
 * 工作環境連不到證交所，只能在 GitHub Actions 跑。
 */
const dates = (process.argv[2] ?? '2026-11-06,2020-03-19,2012-01-03').split(',');
const candidates = (d: string) => {
  const ymd = d.replace(/-/g, '');
  return [
    `https://www.twse.com.tw/rwd/zh/SBL/TWT72U?date=${ymd}&response=json`,
    `https://www.twse.com.tw/rwd/zh/SBL/TWTB4U?date=${ymd}&response=json`,
    `https://www.twse.com.tw/rwd/zh/SBL/TWT96U?date=${ymd}&response=json`,
    `https://www.twse.com.tw/rwd/zh/SBL/TWTASU?date=${ymd}&response=json`,
    `https://www.twse.com.tw/rwd/zh/SBL/TWTAUU?date=${ymd}&response=json`,
    `https://www.twse.com.tw/rwd/zh/SBL/t13sa710?date=${ymd}&response=json`,
  ];
};
const once = [
  'https://openapi.twse.com.tw/v1/exchangeReport/TWT72U',
  'https://openapi.twse.com.tw/v1/exchangeReport/TWTB4U',
  'https://openapi.twse.com.tw/v1/exchangeReport/TWT93U',
];
async function show(url: string) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'macro-tw-dashboard probe' }, signal: AbortSignal.timeout(60_000) });
    const text = await r.text();
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      console.log(`::warning title=${url}::HTTP ${r.status} 非 JSON：${text.slice(0, 120)}`);
      return;
    }
    const o = j as { stat?: string; date?: string; fields?: string[]; groups?: unknown; data?: string[][]; tables?: { title?: string; fields?: string[]; groups?: unknown; data?: string[][] }[] };
    const ts = Array.isArray(j) ? [{ title: 'openapi', fields: Object.keys((j as object[])[0] ?? {}), data: (j as object[]).slice(0, 2).map((x) => Object.values(x) as string[]), n: (j as object[]).length }] : (o.tables?.length ? o.tables : [o]).map((t) => ({ title: t.title, fields: t.fields, groups: t.groups, data: t.data?.slice(0, 2), n: t.data?.length }));
    console.log(`::notice title=${url.replace('https://', '')}::HTTP ${r.status} stat=${o.stat ?? '-'} date=${o.date ?? '-'} ${((Date.now() - t0) / 1000).toFixed(1)}s ${JSON.stringify(ts).slice(0, 1500)}`);
  } catch (e) {
    console.log(`::warning title=${url}::${e instanceof Error ? e.message : String(e)}`);
  }
}
for (const u of once) await show(u);
for (const d of dates) for (const u of candidates(d)) await show(u);
