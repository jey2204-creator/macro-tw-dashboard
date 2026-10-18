import type { ReactNode } from 'react';

/**
 * 面板說明收合：預設收起，點「ⓘ 說明」才展開。
 * 手機上長說明會把圖表擠到第二個畫面，收起後圖表直接上移。
 * 用原生 <details>，不需狀態、鍵盤與螢幕閱讀器都可用。
 */
export function PanelNote({ label = 'ⓘ 說明', children }: { label?: string; children: ReactNode }) {
  return (
    <details className="panel-note">
      <summary className="small">{label}</summary>
      <div className="panel-note-body">{children}</div>
    </details>
  );
}
