// 台灣景氣資料源探測 第二輪（暫時性，合併前移除）：公布日程、外銷訂單即時性、新聞稿日期清單
import { appendFile, mkdir, writeFile } from 'node:fs/promises';

const OUT = process.argv[2] ?? 'out';
await mkdir(`${OUT}/raw`, { recursive: true });
const ME = 'macro-tw-dashboard/0.1 (+https://github.com/jey2204-creator/macro-tw-dashboard)';
const CH = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const DEADLINE = Date.now() + 11 * 60_000;

const log = async (s) => {
  console.log(s);
  await appendFile(`${OUT}/log.txt`, s + '\n');
};

async function get(name, url, { ua = ME, headers = {}, method = 'GET', body } = {}) {
  const t0 = Date.now();
  if (t0 > DEADLINE) return null;
  try {
    const r = await fetch(url, {
      method,
      body,
      headers: { 'User-Agent': ua, Accept: '*/*', ...headers },
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
    });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length <= 30 * 1024 * 1024) await writeFile(`${OUT}/raw/${name}`, buf);
    await log(`GET ${name} | ${r.status} ${r.headers.get('content-type')} ${buf.length}B ${Date.now() - t0}ms | ${r.url}`);
    return { status: r.status, buf, url: r.url };
  } catch (e) {
    const c = e?.cause;
    await log(`GET ${name} | ERR ${Date.now() - t0}ms ${c?.code ?? ''} ${String(c ?? e).slice(0, 200)} | ${url}`);
    return null;
  }
}

async function dataset(id) {
  const res = await get(`meta-${id}.json`, `https://data.gov.tw/api/v2/rest/dataset/${id}`);
  if (!res?.buf) return;
  try {
    const r = JSON.parse(res.buf.toString('utf8'))?.result;
    await log(`DATASET ${id} | ${r?.title} | ${(r?.distribution ?? []).length} 個資源`);
    for (const [k, d] of (r?.distribution ?? []).entries()) {
      await log(`   - ${d.resourceFormat} | ${d.resourceDescription} | ${d.resourceDownloadUrl}`);
      if (k < 4 && d.resourceDownloadUrl) await get(`res-${id}-${k}.${String(d.resourceFormat).toLowerCase()}`, d.resourceDownloadUrl);
    }
  } catch (e) {
    await log(`DATASET ${id} 解析失敗 ${e}`);
  }
}

// 1) 新聞稿日期清單（景氣概況）、景氣循環峰谷、海關發布時間表、可能的政府統計發布時間表
for (const id of ['27543', '39486', '23832', '23828', '137220', '23835']) await dataset(id);

// 2) 主計總處 預告統計資料發布時間表（政府各機關統計發布日程）
await get('stat-calendar.html', 'https://www.stat.gov.tw/News_NoticeCalendar.aspx?n=3717', { ua: CH });
await get('stat-calendar-future.html', 'https://www.stat.gov.tw/News_NoticeCalendar_Future.aspx?n=3907', { ua: CH });
await get('stat-calendar-me.html', 'https://www.stat.gov.tw/News_NoticeCalendar.aspx?n=3717');

// 3) 外銷訂單：有沒有比開放資料（落後約一個月）更即時的來源
await get('moea-dos-home.html', 'https://www.moea.gov.tw/Mns/dos/home/Home.aspx', { ua: CH });
await get('moea-dos-bulletin.html', 'https://www.moea.gov.tw/Mns/dos/bulletin/Bulletin.aspx?kind=5&html=1&menu_id=6724', { ua: CH });
await get('moea-gmweb.html', 'https://dmz26.moea.gov.tw/GMWeb/investigate/InvestigateDA.aspx?lang=C', { ua: CH });
await get('moea-opendata-a.csv', 'https://service.moea.gov.tw/EE520/opendata/a.csv');
await get('moea-opendata-c.csv', 'https://service.moea.gov.tw/EE520/opendata/c.csv');
await get('statdb-root.html', 'https://statdb.dgbas.gov.tw/pxweb/Dialog/statfile9L.asp', { ua: CH });
await get('ndc-news-list.html', 'https://www.ndc.gov.tw/News.aspx?n=CBD8CB46E1F3A4F2', { ua: CH });

await log('完成');
