import { useEffect, useState } from 'react';
import { JUMP_TARGETS, jumpTo, stickyHeight } from '../lib/jump';

/** 目前畫面頂端所在的面板（用來把按鈕標成已選） */
function useActiveSection(): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const line = stickyHeight() + 40;
      let cur: string | null = null;
      for (const t of JUMP_TARGETS) {
        const el = document.getElementById(t.id);
        if (el && el.getBoundingClientRect().top <= line) cur = t.id;
      }
      setActive(cur);
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);
  return active;
}

/** 頁首下方一排跳轉按鈕（桌機單行可左右滑；手機換行全部露出） */
export function JumpNav() {
  const active = useActiveSection();
  return (
    <nav className="jumpnav" aria-label="跳到面板">
      {JUMP_TARGETS.map((t) => (
        <button key={t.id} type="button" aria-current={active === t.id ? 'true' : undefined} onClick={() => jumpTo(t.id)}>
          {t.label}
        </button>
      ))}
    </nav>
  );
}

/** 右下角回頂端按鈕：捲超過約一個畫面才出現 */
export function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > window.innerHeight);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (!show) return null;
  return (
    <button type="button" className="to-top" aria-label="回到頂端" onClick={() => window.scrollTo({ top: 0, behavior: 'auto' })}>
      ↑
    </button>
  );
}
