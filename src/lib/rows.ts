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

export function statusTags(row: RowModel): { text: string; cls: string; title: string }[] {
  const tags: { text: string; cls: string; title: string }[] = [];
  const e = row.entry;
  if (!e || e.status === 'error') tags.push({ text: '失敗', cls: 'tag-err', title: e?.errors.join('\n') ?? '無資料' });
  else {
    if (e.status === 'cached') tags.push({ text: '快取', cls: 'tag-warn', title: `來源暫時失敗，顯示上次成功資料\n${e.errors.join('\n')}` });
    if (e.status === 'fallback') tags.push({ text: '備援', cls: 'tag-warn', title: `主要來源失敗，改用 ${e.source.provider}\n${e.errors.join('\n')}` });
    if (row.ev.stale) tags.push({ text: '過時', cls: 'tag-err', title: `超過 ${row.ev.def.maxAgeDays} 天未更新（可能休市或來源延遲）` });
    if (e.partial) tags.push({ text: '盤中', cls: 'tag-info', title: '最後一根為盤中資料，尚未收盤' });
  }
  return tags;
}

