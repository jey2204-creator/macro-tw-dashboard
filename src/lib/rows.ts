import { closureNote, marketOf, MARKET_TEXT } from '../shared/marketHolidays';
import type { IndicatorEval } from '../shared/regime';
import { recentDirection, type Direction } from '../shared/signals';
import { lastChange, transformPoints, type ChangeInfo } from '../shared/timeseries';
import type { SummaryEntry, SummaryFile } from '../shared/types';

export interface RowModel {
  ev: IndicatorEval;
  entry: SummaryEntry | undefined;
  change: ChangeInfo;
  direction: { dir: Direction; text: string };
  /** Fed 區間下緣（若有） */
  pairValue: number | null;
}

export function buildRow(ev: IndicatorEval, summary: SummaryFile): RowModel {
  const entry = summary.entries[ev.def.id];
  const pair = ev.def.pairId ? summary.entries[ev.def.pairId] : undefined;
  const pairPts = pair ? transformPoints({ transform: 'none' }, pair.tail) : [];
  return {
    ev,
    entry,
    change: lastChange(ev.points),
    direction: recentDirection(ev.def, ev.points),
    pairValue: pairPts.at(-1)?.[1] ?? null,
  };
}

export function statusTags(row: RowModel, now?: Date): { text: string; cls: string; title: string }[] {
  const tags: { text: string; cls: string; title: string }[] = [];
  const e = row.entry;
  if (!e || e.status === 'error') tags.push({ text: '失敗', cls: 'tag-err', title: e?.errors.join('\n') ?? '無資料' });
  else {
    if (e.status === 'cached') tags.push({ text: '快取', cls: 'tag-warn', title: `來源暫時失敗，顯示上次成功資料\n${e.errors.join('\n')}` });
    if (e.status === 'fallback') tags.push({ text: '備援', cls: 'tag-warn', title: `主要來源失敗，改用 ${e.source.provider}\n${e.errors.join('\n')}` });
    if (row.ev.stale) tags.push({ text: '過時', cls: 'tag-err', title: `超過 ${row.ev.def.maxAgeDays} 天未更新（可能休市或來源延遲）` });
    if (row.ev.yoyGap && !row.ev.stale) {
      const m = Number(row.ev.yoyGap.slice(5));
      tags.push({ text: '缺基期', cls: 'tag-info', title: `${m} 月指數已公布，但去年 ${m} 月官方沒有公布指數，算不出年增率（官方也不公布）；判斷沿用上一期，下個月恢復` });
    }
    if (e.partial) tags.push({ text: '盤中', cls: 'tag-info', title: '最後一根為盤中資料，尚未收盤' });
    // 公告休市：今天沒有新資料是正常的（只標每日更新的台股、美股列）
    const mkt = now ? marketOf(row.ev.def) : null;
    const note = mkt && now ? closureNote(mkt, now) : null;
    if (note && mkt) {
      const m = MARKET_TEXT[mkt];
      tags.push({ text: '休市', cls: 'tag-info', title: `${m.name}${note.when === 'today' ? '今天' : '上一個交易日'}休市（${note.name}，${note.date}）：沒有新資料是正常的` });
    }
  }
  return tags;
}

