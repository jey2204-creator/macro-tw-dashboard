/** 快速跳轉目標：id 對應各面板 section 的 id，順序＝頁面順序 */
export const JUMP_TARGETS = [
  { id: 'sec-table', label: '指標' },
  { id: 'sec-cm', label: '跨市場' },
  { id: 'sec-pi', label: '政策利率' },
  { id: 'sec-fc', label: '外資' },
  { id: 'sec-ms', label: '融資' },
  { id: 'sec-br', label: '漲跌停' },
] as const;

const GAP_PX = 6;
/** 跳轉後持續校正的時間：延遲載入的面板（跨市場、政策利率）長出內容時，目標會被往下推 */
const SETTLE_MS = 1500;

export function stickyHeight(): number {
  const el = document.querySelector<HTMLElement>('.sticky-top');
  return el ? el.offsetHeight : 0;
}

function targetTop(el: HTMLElement): number {
  return el.getBoundingClientRect().top + window.scrollY - stickyHeight() - GAP_PX;
}

/** 跳到面板頂端；之後 1.5 秒內若上方面板載入改變高度，自動再對準（Safari 不保證 scroll anchoring） */
export function jumpTo(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  window.scrollTo({ top: targetTop(el), behavior: 'auto' });
  if (typeof ResizeObserver === 'undefined') return;
  const start = Date.now();
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  // 使用者自己動手滑就不再校正
  window.addEventListener('touchstart', cancel, { once: true, passive: true });
  window.addEventListener('wheel', cancel, { once: true, passive: true });
  const ro = new ResizeObserver(() => {
    if (cancelled || Date.now() - start > SETTLE_MS) return;
    const want = targetTop(el);
    if (Math.abs(window.scrollY - want) > 4) window.scrollTo({ top: want, behavior: 'auto' });
  });
  ro.observe(document.body);
  window.setTimeout(() => {
    ro.disconnect();
    window.removeEventListener('touchstart', cancel);
    window.removeEventListener('wheel', cancel);
  }, SETTLE_MS);
}
