import { useEffect, useState } from 'react';
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
