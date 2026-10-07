/**
 * 開發輔助：以「事先擷取的真實 API 回應」重播資料管線（離線、不連網）。
 * 用法：tsx scripts/replay-capture.ts <captureDir> <outDir> <nowISO>
 * captureDir 需含 yahoo.json / fred.json / tpex.json（格式見 README「離線重播」）。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runPipeline } from './fetch-data/pipeline';

interface Capture { data: Record<string, unknown> }

async function main() {
  const [dir, outDir, nowIso] = process.argv.slice(2);
  if (!dir || !outDir) throw new Error('用法：tsx scripts/replay-capture.ts <captureDir> <outDir> [nowISO]');
  const load = async (f: string) => JSON.parse(await readFile(path.join(dir, f), 'utf8')) as Capture;
  const [yahoo, fred, tpex] = await Promise.all([load('yahoo.json'), load('fred.json'), load('tpex.json')]);
  const ok = (body: string) => new Response(body, { status: 200 });
  const fetchImpl = async (url: string): Promise<Response> => {
    const u = new URL(url);
    if (u.hostname.includes('yahoo')) {
      const sym = decodeURIComponent(u.pathname.split('/').pop()!);
      const d = yahoo.data[sym];
      return d ? ok(JSON.stringify(d)) : new Response('{}', { status: 404 });
    }
    if (u.hostname.includes('stlouisfed')) {
      const d = fred.data[u.searchParams.get('id')!];
      return typeof d === 'string' ? ok(d) : new Response('', { status: 404 });
    }
    if (u.hostname.includes('tpex')) {
      const d = tpex.data[u.searchParams.get('date')!];
      return d ? ok(JSON.stringify(d)) : new Response('', { status: 404 });
    }
    return new Response('', { status: 404 });
  };
  await runPipeline({
    outDir: path.resolve(outDir),
    fetchImpl,
    now: nowIso ? new Date(nowIso) : new Date(),
    fast: true,
    log: (m) => console.log(m),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
