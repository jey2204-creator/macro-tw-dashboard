import { SIGNAL_LABEL } from '../shared/regime';
import type { Signal } from '../shared/types';

export function SignalBadge({
  signal,
  muted = false,
  title,
  info = false,
}: {
  signal: Signal;
  muted?: boolean;
  title?: string;
  /** 僅供參考的指標：顯示「參考」而非多空 */
  info?: boolean;
}) {
  if (info)
    return (
      <span className="sig sig-info" title={title}>
        參考
      </span>
    );
  return (
    <span className={`sig sig-${signal}${muted ? ' sig-muted' : ''}`} title={title}>
      {SIGNAL_LABEL[signal]}
    </span>
  );
}
