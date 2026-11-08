/**
 * 探測證交所「借券餘額」（有價證券借貸，SBL）資料源：印出各候選端點的 stat、欄位、前 2 列、列數與合計。
 * 工作環境連不到證交所，只能在 GitHub Actions 跑。
 */
export {};
const dates = (process.argv[2] ?? '2026-11-06,2020-03-19,2012-01-03,2010-01-04').split(',');
const candidates = (d: string) => {
  const ymd = d.replace(/-/g, '');
  return [
    `https://www.twse.com.tw/exchangeReport/TWT72U?date=${ymd}&selectType=SLBNLB&response=json`,
    `https://www.twse.com.tw/exchangeReport/TWT72U?date=${ymd}&selectType=SLB&response=json`,
    `https://www.twse.com.tw/exchangeReport/TWT72U?date=${ymd}&selectType=NLB&response=json`,
    `https://www.twse.com.tw/exchangeReport/TWT72U?date=${ymd}&response=json`,
  ];
};
const once: string[] = [];
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
    const t = o.tables?.[0] ?? o;
    const iBal = t.fields?.findIndex((f) => /本日借券餘額/.test(f)) ?? -1;
    const num = (x?: string) => Number((x ?? '').replace(/,/g, '')) || 0;
    const iMkt = t.fields?.findIndex((f) => /市場別/.test(f)) ?? -1;
    const rowsAll = t.data ?? [];
    const sum = iBal >= 0 ? rowsAll.reduce((a, r) => a + num(r[iBal]), 0) : null;
    const twse = iBal >= 0 ? rowsAll.filter((r) => iMkt < 0 || /集中/.test(r[iMkt] ?? '')) : [];
    const sumTwse = twse.reduce((a, r) => a + num(r[iBal]), 0);
    const sumTwseStock = twse.filter((r) => /^\d{4}$/.test((r[0] ?? '').trim())).reduce((a, r) => a + num(r[iBal]), 0);
    const mkts = iMkt >= 0 ? [...new Set(rowsAll.map((r) => r[iMkt]))].join('/') : '-';
    if (iMkt >= 0) {
      const byMkt = new Map<string, { n: number; sum: number; etf: number; stock: number }>();
      for (const r of rowsAll) {
        const k = r[iMkt] ?? '?';
        const v = byMkt.get(k) ?? { n: 0, sum: 0, etf: 0, stock: 0 };
        v.n++;
        v.sum += num(r[iBal]);
        if (/^00/.test(r[0] ?? '')) v.etf += num(r[iBal]);
        if (/^\d{4}$/.test((r[0] ?? '').trim())) v.stock += num(r[iBal]);
        byMkt.set(k, v);
      }
      // 去重：同一代號（去空白）只留第一筆，看是否剛好是合計的一半
      const seen = new Set<string>();
      let dedupTwse = 0, dLend = 0, dRet = 0, dupN = 0;
      const samples: string[] = [];
      const iLend = t.fields?.findIndex((f) => /異動股借券/.test(f)) ?? -1;
      const iRet = t.fields?.findIndex((f) => /異動股還券/.test(f)) ?? -1;
      for (const r of rowsAll) {
        const code = (r[0] ?? '').trim();
        if (!/集中/.test(r[iMkt] ?? '')) continue;
        if (seen.has(code)) { dupN++; if (samples.length < 3) samples.push(JSON.stringify(r)); continue; }
        seen.add(code);
        dedupTwse += num(r[iBal]); dLend += num(r[iLend]); dRet += num(r[iRet]);
      }
      console.log(`::notice title=dedup ${url.slice(-40)}::集中去重後 餘額=${(dedupTwse / 1e7).toFixed(1)} 借券=${(dLend / 1e7).toFixed(1)} 還券=${(dRet / 1e7).toFixed(1)} 重複列數=${dupN} 重複樣本=${samples.join(' | ').slice(0, 400)}`);
      const pick = rowsAll.filter((r) => ['2330', '2317', '0050', '2344', '6488'].includes((r[0] ?? '').trim()));
      console.log(`::notice title=rows ${url.slice(-40)}::${JSON.stringify(pick)}`);
      const codes = rowsAll.map((r) => r[0]);
      const dup = codes.filter((c, i) => codes.indexOf(c) !== i).slice(0, 5);
      const whole = rowsAll.filter((r) => /整體/.test(r[iMkt] ?? '')).slice(0, 3).map((r) => r.slice(0, 2).concat(r[iBal] ?? ''));
      console.log(`::notice title=mkt ${url.slice(-40)}::${JSON.stringify([...byMkt].map(([k, v]) => [k, v.n, (v.sum / 1e7).toFixed(1), 'etf', (v.etf / 1e7).toFixed(1), 'stock4', (v.stock / 1e7).toFixed(1)]))} 重複代號=${JSON.stringify(dup)} 整體市場樣本=${JSON.stringify(whole)}`);
    }
    console.log(`::notice title=sum ${url.slice(-40)}::全部=${(sum! / 1e7).toFixed(1)}萬張 集中=${(sumTwse / 1e7).toFixed(1)} 集中4碼股票=${(sumTwseStock / 1e7).toFixed(1)} 市場別=${mkts} 列數 全部${rowsAll.length}/集中${twse.length}`);
    console.log(`::notice title=${url.replace('https://', '')}::HTTP ${r.status} stat=${o.stat ?? '-'} date=${o.date ?? '-'} ${((Date.now() - t0) / 1000).toFixed(1)}s 合計(股)=${sum} ${JSON.stringify(ts).slice(0, 1200)}`);
  } catch (e) {
    console.log(`::warning title=${url}::${e instanceof Error ? e.message : String(e)}`);
  }
}
for (const u of once) await show(u);
for (const d of dates) for (const u of candidates(d)) await show(u);
