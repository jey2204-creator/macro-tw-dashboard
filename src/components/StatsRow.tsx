import { pctCell } from '../lib/stressFormat';
import type { EventStats } from '../shared/marginStress';

/** 事件回測表的一列：次數、之後 20／60 日報酬、60 日上漲機率、60 日內最大跌幅 */
export function StatsRow({ label, s, hl }: { label: string; s: EventStats; hl?: boolean }) {
  return (
    <tr className={hl ? 'all' : ''}>
      <td>{label}</td>
      <td className="r">{s.n}</td>
      <td className="r">{pctCell(s.avg20)}</td>
      <td className="r">{pctCell(s.avg60)}</td>
      <td className="r">{pctCell(s.win60, false)}</td>
      <td className="r">{pctCell(s.avgMdd60)}</td>
    </tr>
  );
}
