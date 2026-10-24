import { addMonths, monthKey } from '../../../src/shared/dates';
import type { SourceSpec } from '../../../src/shared/indicators';
import type { Bar } from '../../../src/shared/types';
import { getText, type HttpOptions } from '../http';
import type { SourceFetchResult } from './types';

/**
 * KOSIS 國家統計入口網（kosis.kr）「코스피 주가순자산비율 (PBR)」（來源：韓國交易所；月、年，2004-01 起）：
 * KRX 自家資料平台 2024-12 起要登入，KOSIS 轉載的同一份資料不用登入也沒有 API 金鑰。
 *
 * 2026-10-24 探測（內建瀏覽器）：統計表頁是多層 iframe 的舊式網頁應用，資料由
 *   POST https://kosis.kr/statHtml/html.do（表單）
 * 回傳 JSON，`result[0]` 是一段 HTML table（欄＝月份、列＝KOSPI／KOSPI 200／…）。
 * 不需要 Cookie 也不需要 X-Requested-With；表單欄位很多但內容固定，只有 `fieldList` 裡的月份清單要換；
 * 一次可要整段 2004-01～當月（273 個月、約 600 KB）。少給欄位會回「에러가 발생했습니다!」，所以整組照抄。
 *
 * 每次執行整批重抓（檔案小、月底值偶有修正）。
 */

export type KosisSymbol = Extract<SourceSpec, { provider: 'kosis' }>['symbol'];

export const KOSIS_URL = 'https://kosis.kr/statHtml/html.do';
export const KOSIS_FIRST_MONTH = '2004-01';

interface KosisTable {
  orgId: string;
  tblId: string;
  /** 列軸（分類）代碼、要的那一列的標題 */
  rowAxis: string;
  rowTitle: string;
  itemId: string;
  classIds: string[];
  tblNm: string;
  tblEngNm: string;
  statId: string;
}

const KOSPI_PBR: KosisTable = {
  orgId: '343',
  tblId: 'DT_343_2010_S0034',
  rowAxis: '13101792822A',
  rowTitle: 'KOSPI',
  itemId: '13103792822T1',
  classIds: ['13102792822A.01', '13102792822A.02', '13102792822A.04', '13102792822A.05', '13102792822A.06', '13102792822A.07'],
  tblNm: '코스피 주가순자산비율 (PBR)',
  tblEngNm: 'Price Book-value Ratio(PBR) of KOSPI',
  statId: '1976006',
};

export const KOSIS_TABLE: Record<KosisSymbol, KosisTable> = { KOSPI_PBR };

/** 由新到舊的月份鍵（YYYYMM） */
export function kosisMonths(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = `${monthKey(to)}-01`; monthKey(d) >= from; d = addMonths(d, -1)) out.push(monthKey(d).replace('-', ''));
  return out;
}

/** 統計表頁 ParamInfo 表單的完整欄位（2026-10-24 抄下；fieldList 另外組） */
export function kosisForm(t: KosisTable, months: readonly string[]): [string, string][] {
  const fieldList = JSON.stringify([
    { targetId: 'PRD', targetValue: '', prdValue: `M,${months.join(',')},@` },
    { targetId: 'ITM_ID', targetValue: t.itemId, prdValue: '' },
    ...t.classIds.map((id) => ({ targetId: 'OV_L1_ID', targetValue: id, prdValue: '' })),
  ]);
  const sub = [t.classIds[0]!.replace(/\.\d+$/, '.0701'), t.classIds[0]!.replace(/\.\d+$/, '.0702'), t.classIds[0]!.replace(/\.\d+$/, '.0703')];
  return [
    ['jsonStr', ''], ['orgId', t.orgId], ['tblId', t.tblId], ['language', 'ko'], ['file', ''], ['analText', ''], ['scrId', ''],
    ['fieldList', fieldList], ['colAxis', 'TIME'], ['rowAxis', t.rowAxis], ['isFirst', 'N'], ['contextPath', '/statHtml'],
    ['ordColIdx', ''], ['ordType', ''], ['logSeq', '0'], ['vwCd', 'MT_ZTITLE'], ['listId', ''], ['connPath', ''], ['statId', t.statId],
    ['pub', ''], ['pubLog', '3'], ['viewKind', '1'], ['viewSubKind', ''], ['doAnal', 'N'], ['analType', ''], ['analCmpr', ''],
    ['analTime', ''], ['analCombo', ''], ['originData', ''], ['analClass', ''], ['analItem', ''], ['obj_var_id', ''], ['itm_id', ''],
    ['mode', ''], ['dataOpt', 'ko'], ['noSelect', ''], ['view', 'table'], ['mobChk', 'false'], ['analWithCHGRATE', ''],
    ['defaulPeriodArr', JSON.stringify({ M: months.map(Number) })],
    ['defaultClassArr', JSON.stringify([
      { objVarId: t.rowAxis, data: t.classIds, classType: 1, classLvlCnt: t.classIds.length },
      { objVarId: t.rowAxis, data: sub, classType: 2, classLvlCnt: 3 },
    ])],
    ['defaultItmArr', JSON.stringify([{ data: [t.itemId] }])], ['existStblCmmtKor', 'Y'], ['existStblCmmtEng', 'N'],
    ['classAllArr', JSON.stringify([{ objVarId: t.rowAxis, ovlSn: '1' }])],
    ['classSet', JSON.stringify([{ objVarId: t.rowAxis, ovlSn: '1', visible: 'true' }])],
    ['selectAllFlag', 'N'], ['selectTimeRangeCnt', ''], ['periodStr', 'M#Y'], ['funcPrdSe', 'M'], ['tblNm', t.tblNm], ['tblEngNm', t.tblEngNm],
    ['isChangedDataOpt', ''], ['itemMultiply', '9'], ['dimCo', ''], ['dbUser', 'NSI.'], ['usePivot', 'N'], ['isChangedTableType', 'N'],
    ['isChangedPeriodCo', 'N'], ['isChangedPrdSort', 'N'], ['p_chkStatus', ''], ['p_objVarId', ''], ['p_lvl', ''], ['p_logicFlag', ''],
    ['p_classAllChkYn', 'N'], ['p_classAllSelectYn', 'N'], ['useAddFuncLog', ''], ['chargerLvl', ''], ['st', ''], ['new_win', ''],
    ['first_open', ''], ['debug', ''], ['maxCellOver', ''], ['reqCellCnt', '0'], ['inheritYn', 'N'], ['originOrgId', ''], ['originTblId', ''],
    ['pubSeType', ''], ['relChkOrgId', ''], ['relChkTblId', ''], ['highLightStr', ''], ['markType', ''], ['docId', ''], ['itmNm', ''],
    ['cmmtChk', 'Y'], ['labelOriginData', '원자료 함께 보기'], ['diviSearchYn', ''], ['orderStr', 'OV_L1_ID,TIME'], ['startNum', '1'],
    ['endNum', String(months.length * (t.classIds.length + 3))], ['lastChk', 'N'], ['colClsAt', 'N'], ['analyzable', 'true'], ['tmprScrId', ''],
    ['expDash', 'Y'], ['downGridFileType', 'xlsx'], ['downGridCellMerge', 'Y'], ['downGridMeta', 'Y'], ['downSort', 'asc'], ['pointType', 'screen'],
    ['downLargeFileType', 'excel'], ['downLargeExprType', '1'], ['downLargeSort', 'asc'], ['dataFormatValue', ''], ['printTypeValue', ''],
    ['apiKey', ''], ['apiKey2', ''], ['makeURL', ''], ['url_id', ''], ['apiKey3', ''], ['format', 'xml'], ['prdseSelect', 'N'],
    ['createUrlService', 'insertUrlData'], ['dataFormat', 'json'], ['stat', 'tblId'], ['insertUrlService', 'data'], ['prdSortPop', 'asc'],
    ['naviInfo', 'tabItemText'], ['naviInfo', t.rowAxis], ['naviInfo', 'tabTimeText'], ['assayLeft', 'none'], ['assayselectType', 'none'],
    ['selectType', ''], ['assayRight', 'none'], ['tableType', 'default'], ['dataOpt2', 'ko'], ['periodCo', ''], ['enableLevelExpr', 'Y'],
    ['prdSort', 'asc'], ['compValue', ''], ['compValue01', ''], ['compValue02', ''],
  ];
}

/** 解析 html.do 的 JSON：取 rowTitle 那一列，表頭月份（2026.09）→ 值 */
export function parseKosis(json: string, rowTitle: string): Bar[] {
  let j: { result?: string[]; errMsg?: string };
  try {
    j = JSON.parse(json) as { result?: string[]; errMsg?: string };
  } catch (e) {
    throw new Error(`KOSIS 回應不是 JSON（前 300 字：${json.replace(/\s+/g, ' ').slice(0, 300)}）`, { cause: e });
  }
  if (j.errMsg && !j.result?.length) throw new Error(`KOSIS 回傳錯誤：${j.errMsg}`);
  const html = j.result?.[0] ?? '';
  const heads = [...html.matchAll(/<th class='colHead[^']*'[^>]*title='(\d{4})\.(\d{2})'/g)].map((m) => `${m[1]}-${m[2]}-01`);
  const rowRe = new RegExp(`<tr><td class='first trHeader' title='${rowTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'[\\s\\S]*?</tr>`);
  const row = rowRe.exec(html)?.[0];
  if (!row) throw new Error(`KOSIS 找不到「${rowTitle}」列（版面可能改變）`);
  const vals = [...row.matchAll(/<td class='value'[^>]*>[\s\S]*?<span class='val'>([^<]*)<\/span>/g)].map((m) => m[1]!.trim());
  if (vals.length !== heads.length) throw new Error(`KOSIS 欄數不符：表頭 ${heads.length}、值 ${vals.length}`);
  const out: Bar[] = [];
  heads.forEach((d, i) => {
    const v = Number(vals[i]!.replace(/,/g, ''));
    if (Number.isFinite(v) && v > 0) out.push([d, v, v, v, v]);
  });
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** 統計表頁（先 GET 一次拿 Cookie；2026-10-24 GitHub 實測：直接 POST 會回一頁只有 script 的 HTML） */
export const kosisPageUrl = (t: KosisTable) => `https://kosis.kr/statHtml/statHtml.do?orgId=${t.orgId}&tblId=${t.tblId}`;
/** 與瀏覽器從統計表頁送出查詢時相同的標頭 */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** GET 統計表頁，回傳 Cookie 標頭值（沒有 Set-Cookie 時為空字串） */
export async function kosisSession(t: KosisTable, http: HttpOptions): Promise<string> {
  const res = await http.fetchImpl(kosisPageUrl(t), {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.5' },
    signal: AbortSignal.timeout(http.timeoutMs ?? 20_000),
  });
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  return raw
    .map((c) => c.split(';')[0]!.trim())
    .filter(Boolean)
    .join('; ');
}

export async function fetchKosis(symbol: KosisSymbol, today: string, http: HttpOptions): Promise<SourceFetchResult> {
  const t = KOSIS_TABLE[symbol];
  const months = kosisMonths(KOSIS_FIRST_MONTH, today);
  const body = new URLSearchParams();
  for (const [k, v] of kosisForm(t, months)) body.append(k, v);
  let cookie = '';
  try {
    cookie = await kosisSession(t, http);
  } catch (e) {
    console.warn(`  [kosis] 統計表頁 GET 失敗，直接 POST：${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await getText(KOSIS_URL, http, {
    method: 'POST',
    formBody: body.toString(),
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.5',
      Origin: 'https://kosis.kr',
      Referer: kosisPageUrl(t),
      'X-Requested-With': 'XMLHttpRequest',
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  const bars = parseKosis(text, t.rowTitle);
  if (bars.length < 24) throw new Error(`KOSIS ${t.tblId} 只解析到 ${bars.length} 個月`);
  return { bars, closeOnly: true, partial: false, incremental: false };
}
