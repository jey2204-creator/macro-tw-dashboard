/**
 * 外資買賣超 × 台幣（USD/TWD）——外資籌碼對照面板第 4 格「台幣」與讀數列判讀，參考、不計分。
 *
 * 要回答的問題：外資大賣時，台幣同步貶（錢匯出去）跟台幣沒貶（錢還停在台灣）之後的加權走勢有沒有差？
 * 門檻事先定好、不依結果調整：
 * - 匯率看 20 個交易日變化（與 20 日累計買賣超同一個視窗）；USD/TWD 升 ≥ 1%＝台幣貶、降 ≥ 1%＝台幣升
 *   （台幣 20 日變化的標準差約 1.2%，3 個月用 2%，見 fedFx.ts）
 * - 買賣超看 20 日累計的近 250 日百分位：≤ 第 20＝賣超偏重、≥ 第 80＝買超偏重
 * - 原本想標「匯出（賣超＋台幣貶）／停泊（賣超但台幣沒貶）」；回測沒過（兩組之後 60 日報酬、大跌比例幾乎一樣，
 *   2010～2017 甚至相反），所以只顯示數字與所在列，不貼多空標籤
 * - 統計：每個交易日一筆（連續多天屬同一段，另算「段數」；相隔超過 20 個交易日才算新的一段）
 */
import { forward, mdd, stats, type EventStats } from './marginStress';
import { valueAtOrBefore } from './policyInflation';
import type { Point } from './timeseries';
import type { ForeignRow } from './foreignChips';

export const FF_DAYS = 20;
export const FF_MOVE_PCT = 1;
export const FF_SELL_PCTL = 0.2;
export const FF_BUY_PCTL = 0.8;

export type FlowState = 'sell' | 'mid' | 'buy';
export type FxMove = 'weak' | 'flat' | 'strong';

export const FLOW_TEXT: Record<FlowState, string> = { sell: '賣超偏重', mid: '一般', buy: '買超偏重' };
export const FX_MOVE_TEXT: Record<FxMove, string> = { weak: '台幣貶 ≥ 1%', flat: '台幣持平', strong: '台幣升 ≥ 1%' };

const r2 = (v: number) => Math.round(v * 100) / 100;

/** 每個籌碼交易日對應的 USD/TWD（當日或之前最近一筆；序列還沒開始為 null） */
export function fxOnRows(rows: readonly ForeignRow[], pts: readonly Point[]): (number | null)[] {
  const first = pts[0]?.[0];
  return rows.map((r) => (first !== undefined && r[0] >= first ? valueAtOrBefore(pts, r[0]) : null));
}

/** USD/TWD 過去 n 個交易日變化 %（正＝台幣貶） */
export function fxChanges(fx: readonly (number | null)[], n = FF_DAYS): (number | null)[] {
  return fx.map((v, i) => {
    const a = i >= n ? fx[i - n] : null;
    return v !== null && a !== null && a !== undefined && a > 0 ? r2((v / a - 1) * 100) : null;
  });
}

export function flowState(pctl: number | null | undefined): FlowState | null {
  if (pctl === null || pctl === undefined) return null;
  if (pctl <= FF_SELL_PCTL) return 'sell';
  if (pctl >= FF_BUY_PCTL) return 'buy';
  return 'mid';
}

export function fxMove(chg: number | null | undefined): FxMove | null {
  if (chg === null || chg === undefined) return null;
  if (chg >= FF_MOVE_PCT) return 'weak';
  if (chg <= -FF_MOVE_PCT) return 'strong';
  return 'flat';
}

export interface FlowFxCell extends EventStats {
  flow: FlowState;
  move: FxMove | 'all';
  /** 獨立段數：同一格連續出現、相隔 ≤ 20 個交易日算同一段 */
  runs: number;
  /** 60 日內曾跌逾 10% 的比例 % */
  crash60: number | null;
}

export interface ForeignFxFile {
  /** 每列 [USD/TWD, 20 日變化 %]，與 rows 同長度 */
  fx: [rate: number | null, chg20: number | null][];
  cells: FlowFxCell[];
  baseline: FlowFxCell;
  latest: { date: string; rate: number | null; chg20: number | null; flow: FlowState | null; move: FxMove | null} | null;
}

export const FF_CRASH_PCT = -10;

function cell(rows: readonly ForeignRow[], idx: number[], flow: FlowState, move: FxMove | 'all'): FlowFxCell {
  const list = idx.map((i) => ({ ret20: forward(rows, i, 20), ret60: forward(rows, i, 60), mdd60: mdd(rows, i, 60) }));
  let runs = 0;
  let prev = -Infinity;
  for (const i of idx) {
    if (i - prev > FF_DAYS) runs++;
    prev = i;
  }
  const m = list.map((x) => x.mdd60).filter((x): x is number => x !== null);
  return {
    flow,
    move,
    runs,
    crash60: m.length ? r2((m.filter((x) => x <= FF_CRASH_PCT).length / m.length) * 100) : null,
    ...stats(list),
  };
}

export function analyzeForeignFx(rows: readonly ForeignRow[], cum20Pctl: readonly (number | null)[], pts: readonly Point[]): ForeignFxFile {
  const rate = fxOnRows(rows, pts);
  const chg = fxChanges(rate);
  const flows = rows.map((_, i) => flowState(cum20Pctl[i]));
  const moves = chg.map((c) => fxMove(c));
  const valid = rows.map((_, i) => i).filter((i) => flows[i] !== null && moves[i] !== null);
  const cells: FlowFxCell[] = [];
  for (const f of ['sell', 'mid', 'buy'] as const) {
    const inFlow = valid.filter((i) => flows[i] === f);
    for (const m of ['weak', 'flat', 'strong'] as const) cells.push(cell(rows, inFlow.filter((i) => moves[i] === m), f, m));
    cells.push(cell(rows, inFlow, f, 'all'));
  }
  const last = rows.length - 1;
  const l = rows[last];
  return {
    fx: rows.map((_, i) => [rate[i] ?? null, chg[i] ?? null]),
    cells,
    baseline: { ...cell(rows, valid, 'mid', 'all'), runs: 1 },
    latest: l
      ? {
          date: l[0],
          rate: rate[last] ?? null,
          chg20: chg[last] ?? null,
          flow: flows[last] ?? null,
          move: moves[last] ?? null,
        }
      : null,
  };
}
