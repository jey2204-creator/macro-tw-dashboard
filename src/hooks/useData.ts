import { useEffect, useMemo, useState } from 'react';
import type { CalendarFile } from '../shared/calendar';
import type { FactsetEpsFile } from '../shared/factsetEps';
import type { BreadthStressFile } from '../shared/breadthStress';
import type { ForeignChipsFile } from '../shared/foreignChips';
import type { MarginStressFile } from '../shared/marginStress';
import type { BacktestFile, SeriesFile, SummaryFile } from '../shared/types';

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: T };

const DATA_BASE = `${import.meta.env.BASE_URL}data`;

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function useSummary(reloadKey = 0): LoadState<SummaryFile> {
  const [state, setState] = useState<LoadState<SummaryFile>>({ status: 'loading' });
  useEffect(() => {
    const ctrl = new AbortController();
    getJson<SummaryFile>(`${DATA_BASE}/summary.json`, ctrl.signal)
      .then((data) => {
        if (data.schemaVersion !== 1 || typeof data.entries !== 'object') throw new Error('資料格式不符');
        setState({ status: 'ready', data });
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      });
    return () => ctrl.abort();
  }, [reloadKey]);
  return state;
}

/** 依 id 載入完整歷史；以 version（summary.generatedAt）作為快取鍵 */
const seriesCache = new Map<string, Promise<SeriesFile>>();

export function useSeries(id: string | null, version: string): LoadState<SeriesFile> | null {
  const [state, setState] = useState<{ key: string; value: LoadState<SeriesFile> } | null>(null);
  const key = id ? `${id}@${version}` : '';
  useEffect(() => {
    if (!id) return;
    let alive = true;
    let p = seriesCache.get(key);
    if (!p) {
      const ctrl = new AbortController();
      p = getJson<SeriesFile>(`${DATA_BASE}/series/${id}.json?v=${encodeURIComponent(version)}`, ctrl.signal);
      seriesCache.set(key, p);
      p.catch(() => seriesCache.delete(key));
    }
    p.then(
      (data) => alive && setState({ key, value: { status: 'ready', data } }),
      (e: unknown) => alive && setState({ key, value: { status: 'error', error: e instanceof Error ? e.message : String(e) } }),
    );
    return () => {
      alive = false;
    };
  }, [id, key, version]);
  if (!id) return null;
  return state && state.key === key ? state.value : { status: 'loading' };
}

function loadSeries(id: string, version: string): Promise<SeriesFile> {
  const key = `${id}@${version}`;
  let p = seriesCache.get(key);
  if (!p) {
    p = getJson<SeriesFile>(`${DATA_BASE}/series/${id}.json?v=${encodeURIComponent(version)}`, new AbortController().signal);
    seriesCache.set(key, p);
    p.catch(() => seriesCache.delete(key));
  }
  return p;
}

/** 一次載入多個指標的完整歷史（跨市場對照用）；每個 id 各自回報載入狀態 */
export function useSeriesMap(ids: readonly string[], version: string): Record<string, LoadState<SeriesFile>> {
  const [state, setState] = useState<Record<string, { v: string; value: LoadState<SeriesFile> }>>({});
  const idKey = ids.join(',');
  useEffect(() => {
    let alive = true;
    for (const id of idKey ? idKey.split(',') : []) {
      loadSeries(id, version).then(
        (data) => alive && setState((s) => ({ ...s, [id]: { v: version, value: { status: 'ready', data } } })),
        (e: unknown) =>
          alive &&
          setState((s) => ({ ...s, [id]: { v: version, value: { status: 'error', error: e instanceof Error ? e.message : String(e) } } })),
      );
    }
    return () => {
      alive = false;
    };
  }, [idKey, version]);
  // 回傳物件只在狀態真的改變時換新，讓使用端的 useMemo／useEffect 不會每次 render 都重算
  return useMemo(() => {
    const out: Record<string, LoadState<SeriesFile>> = {};
    for (const id of idKey ? idKey.split(',') : []) {
      const s = state[id];
      out[id] = s && s.v === version ? s.value : { status: 'loading' };
    }
    return out;
  }, [state, idKey, version]);
}

/** 回測結果為選用資料：載入失敗時回傳 null，不影響主畫面 */
export function useBacktest(version: string | null): BacktestFile | null {
  const [state, setState] = useState<{ v: string; data: BacktestFile | null } | null>(null);
  useEffect(() => {
    if (!version) return;
    const ctrl = new AbortController();
    getJson<BacktestFile>(`${DATA_BASE}/backtest.json?v=${encodeURIComponent(version)}`, ctrl.signal)
      .then((data) => setState({ v: version, data: data.schemaVersion === 1 ? data : null }))
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ v: version, data: null });
      });
    return () => ctrl.abort();
  }, [version]);
  return state && state.v === version ? state.data : null;
}

/** 公布行事曆（市場預期）為選用資料：載入失敗時回傳 null，不影響主畫面 */
export function useCalendar(version: string | null): CalendarFile | null {
  const [state, setState] = useState<{ v: string; data: CalendarFile | null } | null>(null);
  useEffect(() => {
    if (!version) return;
    const ctrl = new AbortController();
    getJson<CalendarFile>(`${DATA_BASE}/calendar.json?v=${encodeURIComponent(version)}`, ctrl.signal)
      .then((data) => setState({ v: version, data: data.schemaVersion === 1 && Array.isArray(data.events) ? data : null }))
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ v: version, data: null });
      });
    return () => ctrl.abort();
  }, [version]);
  return state && state.v === version ? state.data : null;
}

/** 融資斷頭監測（選用資料）：載入失敗時回傳 null */
export function useMarginStress(version: string | null): MarginStressFile | null {
  const [state, setState] = useState<{ v: string; data: MarginStressFile | null } | null>(null);
  useEffect(() => {
    if (!version) return;
    const ctrl = new AbortController();
    getJson<MarginStressFile>(`${DATA_BASE}/margin-stress.json?v=${encodeURIComponent(version)}`, ctrl.signal)
      .then((data) => setState({ v: version, data: data.schemaVersion === 1 && Array.isArray(data.rows) ? data : null }))
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ v: version, data: null });
      });
    return () => ctrl.abort();
  }, [version]);
  return state && state.v === version ? state.data : null;
}

/** 漲跌停家數監測（選用資料）：載入失敗時回傳 null */
export function useBreadthStress(version: string | null): BreadthStressFile | null {
  const [state, setState] = useState<{ v: string; data: BreadthStressFile | null } | null>(null);
  useEffect(() => {
    if (!version) return;
    const ctrl = new AbortController();
    getJson<BreadthStressFile>(`${DATA_BASE}/breadth-stress.json?v=${encodeURIComponent(version)}`, ctrl.signal)
      .then((data) => setState({ v: version, data: data.schemaVersion === 1 && Array.isArray(data.rows) ? data : null }))
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ v: version, data: null });
      });
    return () => ctrl.abort();
  }, [version]);
  return state && state.v === version ? state.data : null;
}

/** 外資籌碼對照（選用資料）：載入失敗時回傳 null */
export function useForeignChips(version: string | null): ForeignChipsFile | null {
  const [state, setState] = useState<{ v: string; data: ForeignChipsFile | null } | null>(null);
  useEffect(() => {
    if (!version) return;
    const ctrl = new AbortController();
    getJson<ForeignChipsFile>(`${DATA_BASE}/foreign-chips.json?v=${encodeURIComponent(version)}`, ctrl.signal)
      .then((data) => setState({ v: version, data: data.schemaVersion === 1 && Array.isArray(data.rows) ? data : null }))
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ v: version, data: null });
      });
    return () => ctrl.abort();
  }, [version]);
  return state && state.v === version ? state.data : null;
}

/** FactSet 週報估值讀數（選用資料）：載入失敗時回傳 null */
export function useFactsetEps(version: string | null): FactsetEpsFile | null {
  const [state, setState] = useState<{ v: string; data: FactsetEpsFile | null } | null>(null);
  useEffect(() => {
    if (!version) return;
    const ctrl = new AbortController();
    getJson<FactsetEpsFile>(`${DATA_BASE}/factset-eps.json?v=${encodeURIComponent(version)}`, ctrl.signal)
      .then((data) => setState({ v: version, data: data.schemaVersion === 1 && Array.isArray(data.posts) ? data : null }))
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ v: version, data: null });
      });
    return () => ctrl.abort();
  }, [version]);
  return state && state.v === version ? state.data : null;
}
