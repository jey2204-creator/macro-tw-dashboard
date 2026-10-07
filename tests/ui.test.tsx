// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndicatorTable } from '../src/components/IndicatorTable';
import { RegimePanel } from '../src/components/RegimePanel';
import { buildRow } from '../src/lib/rows';
import { computeRegime } from '../src/shared/regime';
import type { BacktestFile, SummaryFile } from '../src/shared/types';

// 2026-10-06 實際資料產生的 summary
const summary = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'tests/fixtures/summary-2026-10-06.json'), 'utf8'),
) as SummaryFile;
const backtest = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'tests/fixtures/backtest-2026-10-06.json'), 'utf8'),
) as BacktestFile;
const TODAY = '2026-10-07';

afterEach(cleanup);

describe('UI（真實資料快照）', () => {
  const regime = computeRegime(summary, TODAY);

  it('綜合判斷可完整計分且結果可追溯', () => {
    expect(regime.coverage).toBe(1);
    expect(regime.bullCount + regime.neutralCount + regime.bearCount).toBe(regime.evals.filter((e) => e.counted).length);
    expect(regime.evals.filter((e) => e.excludedReason === '僅供參考').map((e) => e.def.id)).toEqual(['spread', 'wti', 'brent']);
  });

  it('RegimePanel 顯示結論並可展開每個指標的判斷依據', () => {
    const onSelect = vi.fn();
    render(<RegimePanel regime={regime} onSelect={onSelect} backtest={backtest} />);
    expect(screen.getByText('目前市場環境')).toBeTruthy();
    expect(screen.getByText(/歷史上（2010–2026）同樣判/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /查看判斷依據/ }));
    expect(screen.getByText(/不含任何 AI 推測/)).toBeTruthy();
    expect(screen.getByText('多空差')).toBeTruthy();
    expect(screen.getByText(/綜合判斷回測/)).toBeTruthy();
    fireEvent.click(screen.getByText('費半SOX'));
    expect(onSelect).toHaveBeenCalledWith('sox');
  });

  it('沒有回測檔時仍正常顯示', () => {
    render(<RegimePanel regime={regime} onSelect={() => {}} backtest={null} />);
    expect(screen.queryByText(/歷史上/)).toBeNull();
  });

  it('依審查後規則，2026-10-06 快照的結論為中性', () => {
    expect(regime.signal).toBe('neutral');
  });

  it('IndicatorTable 列出所有可見指標，Fed 以區間顯示', () => {
    const rows = regime.evals.map((e) => buildRow(e, summary));
    const onSelect = vi.fn();
    render(<IndicatorTable rows={rows} today={TODAY} selectedId={null} onSelect={onSelect} />);
    expect(screen.getAllByRole('button')).toHaveLength(regime.evals.length);
    expect(screen.getByText('3.75–4.00%')).toBeTruthy();
    expect(screen.getByText('49,822.55')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /台灣加權指數/ }));
    expect(onSelect).toHaveBeenCalledWith('taiex');
  });

  it('指標資料缺失時仍能渲染並標示失敗', () => {
    const broken: SummaryFile = { ...summary, entries: { ...summary.entries } };
    delete broken.entries.sox;
    const r = computeRegime(broken, TODAY);
    const rows = r.evals.map((e) => buildRow(e, broken));
    render(<IndicatorTable rows={rows} today={TODAY} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText('失敗')).toBeTruthy();
    expect(r.evals.find((e) => e.def.id === 'sox')!.counted).toBe(false);
  });
});
