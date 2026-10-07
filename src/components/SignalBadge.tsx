import { SIGNAL_LABEL } from '../shared/regime';
import type { Signal } from '../shared/types';

export function SignalBadge({ signal, muted = false, title }: { signal: Signal; muted?: boolean; title?: string }) {
  return (
    <span className={`sig sig-${signal}${muted ? ' sig-muted' : ''}`} title={title}>
      {SIGNAL_LABEL[signal]}
    </span>
  );
}
