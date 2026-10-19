// 台灣景氣資料源探測（暫時性，合併前移除）
// 在 GitHub Actions 主機上實測：政府資料開放平台 API、國發會、央行、中經院等來源能否抓取、格式為何。
// 用法：node scripts/probe/twProbe.mjs <輸出資料夾>
import { appendFile, mkdir, writeFile } from 'node:fs/promises';

const OUT = process.argv[2] ?? 'out';
await mkdir(`${OUT}/raw`, { recursive: true });
const ME = 'macro-tw-dashboard/0.1 (+https://github.com/jey2204-creator/macro-tw-dashboard)';
const CH = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MAX = 30 * 1024 * 1024;

const log = async (s) => {
  console.log(s);
  await appendFile(`${OUT}/log.txt`, s + '\n');
};

async function get(name, url, { ua = ME, headers = {}, save = true } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': ua, Accept: '*/*', ...headers },
      signal: AbortSignal.timeout(120_000),
      redirect: 'follow',
    });
    const len = Number(r.headers.get('content-length') ?? 0);
    if (len > MAX) {
      await r.body?.cancel();
      await log(`GET ${name} | ${r.status} 太大略過 ${len}B | ${url}`);
      return { status: r.status, buf: null };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (save && buf.length <= MAX) await writeFile(`${OUT}/raw/${name}`, buf);
    await log(`GET ${name} | ${r.status} ${r.headers.get('content-type')} ${buf.length}B ${Date.now() - t0}ms | ${r.url}`);
    return { status: r.status, buf };
  } catch (e) {
    const c = e?.cause;
    await log(`GET ${name} | ERR ${Date.now() - t0}ms ${c?.code ?? ''} ${String(c ?? e).slice(0, 200)} | ${url}`);
    return null;
  }
}

const safe = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 60);

// 1) 直接來源
await get('cbc-EF17M01.csv', 'https://www.cbc.gov.tw/public/data/OpenData/%E7%B6%93%E7%A0%94%E8%99%95/EF17M01.csv');
await get('cier-pmi-trend.html', 'https://www.cier.edu.tw/pmi-trend/');
await get('ndc-eco-me.json', 'https://index.ndc.gov.tw/n/json/data/eco', { save: true });
await get('ndc-eco-ch.json', 'https://index.ndc.gov.tw/n/json/data/eco', { ua: CH });
await get('ndc-root.html', 'https://index.ndc.gov.tw/n/zh_tw', { ua: CH });
await get('moea-orders-page.html', 'https://www.moea.gov.tw/Mns/dos/content/ContentLink.aspx?menu_id=9423', { ua: CH });

// 2) 國網中心 CKAN 鏡像搜尋（找政府資料開放平台的資料集編號）
const terms = ['外銷訂單', '景氣對策信號', '景氣指標', '海關進出口貿易', '貨幣總計數', '採購經理人指數', '出口貿易值'];
const found = new Map(); // id -> title
for (const t of terms) {
  const res = await get(`ckan-${safe(t)}.json`, `https://scidm.nchc.org.tw/api/3/action/package_search?q=${encodeURIComponent(t)}&rows=100`);
  if (!res?.buf) continue;
  try {
    const j = JSON.parse(res.buf.toString('utf8'));
    for (const p of j?.result?.results ?? []) {
      const m = /(\d+)$/.exec(p.name ?? '');
      if (m) found.set(m[1], p.title ?? '');
    }
    await log(`CKAN ${t}: ${j?.result?.count ?? '?'} 筆`);
  } catch (e) {
    await log(`CKAN ${t}: 解析失敗 ${e}`);
  }
}

// 3) 政府資料開放平台 API：資料集描述與下載網址
const fixed = ['6099', '6100', '6024', '6053', '8380', '8382', '8383', '39051', '39052', '62445', '6799'];
const kw = /外銷訂單|景氣|燈號|採購經理人|貨幣總計數|進出口|出口/;
const ids = [...new Set([...fixed, ...[...found.entries()].filter(([, t]) => kw.test(t)).map(([id]) => id)])].slice(0, 60);
await log(`資料集候選 ${ids.length} 個：${ids.join(',')}`);

const summary = [];
let downloads = 0;
for (const id of ids) {
  const res = await get(`meta-${id}.json`, `https://data.gov.tw/api/v2/rest/dataset/${id}`);
  if (!res?.buf) continue;
  let r;
  try {
    r = JSON.parse(res.buf.toString('utf8'))?.result;
  } catch {
    summary.push(`${id} | 非 JSON`);
    continue;
  }
  if (!r) {
    summary.push(`${id} | 無 result`);
    continue;
  }
  const title = r.title ?? r.datasetTitle ?? '?';
  const dist = r.distribution ?? [];
  summary.push(`${id} | ${title} | ${r.publisher ?? r.organization ?? ''} | 更新：${r.updateFrequency ?? r.updateFreq ?? ''} | 資源 ${dist.length}`);
  for (const [k, d] of dist.entries()) {
    const url = d.resourceDownloadUrl ?? d.downloadURL ?? '';
    const fmt = String(d.resourceFormat ?? d.format ?? '').toUpperCase();
    summary.push(`    - ${fmt} | ${d.resourceDescription ?? d.description ?? ''} | ${url}`);
    const relevant = kw.test(title) || fixed.includes(id);
    if (!relevant || !url || downloads >= 80 || k >= 8) continue;
    if (!/CSV|ZIP|JSON|XML|XLS/.test(fmt)) continue;
    downloads++;
    await get(`res-${id}-${k}.${fmt.toLowerCase().split(/\W/)[0] || 'bin'}`, url);
  }
}
await writeFile(`${OUT}/datasets.txt`, summary.join('\n') + '\n');
await writeFile(`${OUT}/ckan-found.txt`, [...found.entries()].map(([id, t]) => `${id}\t${t}`).join('\n') + '\n');
await log(`完成：下載 ${downloads} 個資源`);
