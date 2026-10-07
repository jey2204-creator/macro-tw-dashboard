import { addDays, daysBetween } from './dates';
import type { IndicatorDef, SignalRule } from './indicators';
import { changeOver, sma, valueAtOrBefore, type Point } from './timeseries';
import type { Signal } from './types';

/**
 * 規則式訊號：每個判斷都附上「可讀的依據」字串，UI 直接顯示。
 * 不使用任何模型猜測；規則與門檻皆定義於 indicators.ts，可審閱、可測試。
 */

export interface SignalResult {
  signal: Signal;
  /** 判斷依據（繁中，顯示用） */
  reason: string;
  /** 規則描述（門檻） */
  ruleText: string;
}

const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const signed = (v: number, d = 2) => `${v >= 0 ? '+' : ''}${fmt(v, d)}`;

export function describeRule(rule: SignalRule, def?: Pick<IndicatorDef, 'changeInBp'>): string {
  switch (rule.kind) {
    case 'trend':
      return '檢查 收盤>MA60、MA60較20日前上揚、收盤>MA240：全部成立偏多、全部不成立偏空、其餘中性';
    case 'risingIsBearish': {
      const u = rule.mode === 'pct' ? '%' : def?.changeInBp ? 'bp' : '';
      const k = rule.mode === 'abs' && def?.changeInBp ? 100 : 1;
      const bear = `近${rule.lookback}日變化 ≥ +${rule.bearAt * k}${u} 偏空`;
      const bull = rule.bullAt === null ? '' : `；≤ ${rule.bullAt * k}${u} 偏多`;
      return bear + bull + '；其餘中性';
    }
    case 'curve':
      return '利差 < 0（倒掛）偏空；≥ 0 中性';
    case 'policyRate':
      return `與 ${rule.lookbackDays} 天前比較：已降息偏多、已升息偏空、不變中性`;
    case 'inflationTrend':
      return `年增率較 ${rule.lookback} 個月前下降 ≥ ${rule.threshold}pp 偏多、上升 ≥ ${rule.threshold}pp 偏空`;
    case 'sahm':
      return `Sahm 值（3月均−前12月最低3月均）≥0.5 偏空${rule.bullBelow === null ? '' : `、<${rule.bullBelow} 偏多`}、其餘中性`;
    case 'payrolls':
      return `3個月平均新增 < ${rule.bearAt}k 偏空${rule.bullAt === null ? '' : `、≥ ${rule.bullAt}k 偏多`}、其餘中性`;
    case 'growth':
      return `≥ ${rule.bullAt}% 偏多、< ${rule.bearAt}% 偏空、其餘中性`;
  }
}

function result(signal: Signal, reason: string, rule: SignalRule, def: IndicatorDef): SignalResult {
  return { signal, reason, ruleText: describeRule(rule, def) };
}

const NO_DATA = (def: IndicatorDef): SignalResult => ({
  signal: 'neutral',
  reason: '資料不足，無法判斷',
  ruleText: describeRule(def.rule, def),
});

/** 依指標規則計算訊號；pts 為已轉換（年增率/差值）的顯示數列 */
export function evaluateSignal(def: IndicatorDef, pts: readonly Point[]): SignalResult {
  const rule = def.rule;
  const last = pts.at(-1);
  if (!last) return NO_DATA(def);

  switch (rule.kind) {
    case 'trend': {
      const values = pts.map((p) => p[1]);
      if (values.length < 80) return NO_DATA(def);
      const ma60 = sma(values, 60);
      const ma240 = sma(values, 240);
      const m60 = ma60.at(-1)!;
      const m60prev = ma60.at(-21) ?? null;
      const m240 = ma240.at(-1) ?? null;
      const checks: { label: string; ok: boolean }[] = [];
      if (m60 !== null) checks.push({ label: `收盤${last[1] > m60 ? '>' : '<'}MA60`, ok: last[1] > m60 });
      if (m60 !== null && m60prev !== null)
        checks.push({ label: `MA60${m60 > m60prev ? '上揚' : '下彎'}`, ok: m60 > m60prev });
      if (m240 !== null) checks.push({ label: `收盤${last[1] > m240 ? '>' : '<'}MA240`, ok: last[1] > m240 });
      const pos = checks.filter((c) => c.ok).length;
      const reason = checks.map((c) => `${c.label}${c.ok ? '✓' : '✗'}`).join('、');
      if (checks.length < 2) return NO_DATA(def);
      // 全部一致才判多空（回測顯示多數決版本幾乎沒有預測力）
      const signal: Signal = pos === checks.length ? 'bull' : pos === 0 ? 'bear' : 'neutral';
      return result(signal, reason, rule, def);
    }

    case 'risingIsBearish': {
      const ch = changeOver(pts, rule.lookback);
      if (!ch) return NO_DATA(def);
      const v = rule.mode === 'pct' ? ch.pct : ch.abs;
      if (v === null) return NO_DATA(def);
      const shown =
        rule.mode === 'pct'
          ? `${signed(v, 2)}%`
          : def.changeInBp
            ? `${signed(v * 100, 0)}bp`
            : signed(v, def.decimals);
      const reason = `近${rule.lookback}${def.frequency === 'daily' ? '日' : '期'}變化 ${shown}`;
      let signal: Signal = 'neutral';
      if (v >= rule.bearAt) signal = 'bear';
      else if (rule.bullAt !== null && v <= rule.bullAt) signal = 'bull';
      return result(signal, reason, rule, def);
    }

    case 'curve': {
      const signal: Signal = last[1] < 0 ? 'bear' : 'neutral';
      return result(signal, `利差 ${signed(last[1], 2)}%${last[1] < 0 ? '（倒掛）' : '（正斜率）'}`, rule, def);
    }

    case 'policyRate': {
      const ref = valueAtOrBefore(pts, addDays(last[0], -rule.lookbackDays));
      if (!ref) return NO_DATA(def);
      const d = last[1] - ref[1];
      const bp = Math.round(d * 100);
      const signal: Signal = d < -1e-9 ? 'bull' : d > 1e-9 ? 'bear' : 'neutral';
      const reason =
        bp === 0
          ? `${rule.lookbackDays}天內利率不變（${fmt(last[1])}%）`
          : `${rule.lookbackDays}天內${bp < 0 ? '降息' : '升息'} ${Math.abs(bp)}bp`;
      return result(signal, reason, rule, def);
    }

    case 'inflationTrend': {
      const ch = changeOver(pts, rule.lookback);
      if (!ch) return NO_DATA(def);
      const signal: Signal =
        ch.abs <= -rule.threshold ? 'bull' : ch.abs >= rule.threshold ? 'bear' : 'neutral';
      return result(
        signal,
        `年增 ${fmt(last[1], 1)}%，較${rule.lookback}個月前 ${signed(ch.abs, 1)}pp`,
        rule,
        def,
      );
    }

    case 'sahm': {
      const s = sahmValue(pts);
      if (s === null) return NO_DATA(def);
      const signal: Signal = s >= 0.5 ? 'bear' : rule.bullBelow !== null && s < rule.bullBelow ? 'bull' : 'neutral';
      return result(signal, `失業率 ${fmt(last[1], 1)}%，Sahm 值 ${fmt(s, 2)}`, rule, def);
    }

    case 'payrolls': {
      if (pts.length < 3) return NO_DATA(def);
      const avg = (pts.at(-1)![1] + pts.at(-2)![1] + pts.at(-3)![1]) / 3;
      const signal: Signal = avg < rule.bearAt ? 'bear' : rule.bullAt !== null && avg >= rule.bullAt ? 'bull' : 'neutral';
      return result(signal, `最新 ${signed(last[1], 0)}k，3個月平均 ${signed(avg, 0)}k`, rule, def);
    }

    case 'growth': {
      const signal: Signal = last[1] >= rule.bullAt ? 'bull' : last[1] < rule.bearAt ? 'bear' : 'neutral';
      return result(signal, `${quarterLabel(last[0])} ${signed(last[1], 1)}%`, rule, def);
    }
  }
}

/** Sahm 值：最近 3 個月平均失業率 − 前 12 個月內 3 個月平均的最低值 */
export function sahmValue(pts: readonly Point[]): number | null {
  if (pts.length < 15) return null;
  const v = pts.map((p) => p[1]);
  const avg3 = sma(v, 3);
  const cur = avg3.at(-1);
  const prior = avg3.slice(-13, -1).filter((x): x is number => x !== null);
  if (cur === null || cur === undefined || prior.length === 0) return null;
  return cur - Math.min(...prior);
}

export function quarterLabel(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return `${y}Q${Math.floor((m - 1) / 3) + 1}`;
}

export type Direction = 'up' | 'down' | 'flat';

/** 近期方向：日資料看 20 期、月資料看 3 期、季資料看 1 期 */
export function recentDirection(def: IndicatorDef, pts: readonly Point[]): { dir: Direction; text: string } {
  const n = def.frequency === 'daily' ? 20 : def.frequency === 'weekly' ? 4 : def.frequency === 'monthly' ? 3 : 1;
  const ch = changeOver(pts, n);
  if (!ch) return { dir: 'flat', text: '—' };
  const label = def.frequency === 'daily' ? `${n}日` : def.frequency === 'monthly' ? `${n}月` : `${n}期`;
  // 判斷持平的門檻：價格類 0.5%、利率類 5bp、其他 1% 相對值
  let dir: Direction;
  if (def.changeInBp) dir = Math.abs(ch.abs) < 0.05 ? 'flat' : ch.abs > 0 ? 'up' : 'down';
  else if (def.unit === '%' || def.unit === 'k')
    dir = Math.abs(ch.abs) < (def.unit === 'k' ? 25 : 0.1) ? 'flat' : ch.abs > 0 ? 'up' : 'down';
  else dir = ch.pct === null || Math.abs(ch.pct) < 0.5 ? 'flat' : ch.pct > 0 ? 'up' : 'down';
  const amount = def.changeInBp
    ? `${signed(ch.abs * 100, 0)}bp`
    : def.unit === '%'
      ? `${signed(ch.abs, 1)}pp`
      : def.unit === 'k'
        ? `${signed(ch.abs, 0)}k`
        : `${signed(ch.pct ?? 0, 1)}%`;
  return { dir, text: `${label} ${amount}` };
}

/** 資料是否過時（超過 maxAgeDays） */
export function isStale(def: Pick<IndicatorDef, 'maxAgeDays'>, lastDate: string | null, today: string): boolean {
  if (!lastDate) return true;
  return daysBetween(lastDate, today) > def.maxAgeDays;
}
