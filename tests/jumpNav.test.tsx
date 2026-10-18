// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { JumpNav } from '../src/components/JumpNav';
import { PanelNote } from '../src/components/PanelNote';
import { JUMP_TARGETS } from '../src/lib/jump';

afterEach(cleanup);

describe('JumpNav', () => {
  it('每個面板一顆按鈕，點了捲到該面板（扣掉固定頁首高度）', () => {
    const scroll = vi.fn();
    window.scrollTo = scroll as unknown as typeof window.scrollTo;
    render(
      <div>
        <div className="sticky-top" />
        <JumpNav />
        {JUMP_TARGETS.map((t) => (
          <section key={t.id} id={t.id} />
        ))}
      </div>,
    );
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(JUMP_TARGETS.map((t) => t.label));
    fireEvent.click(screen.getByText('跨市場'));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.calls[0]![0]).toMatchObject({ behavior: 'auto' });
  });
});

describe('PanelNote', () => {
  it('說明預設收起', () => {
    const { container } = render(
      <PanelNote>
        <p>內容</p>
      </PanelNote>,
    );
    const d = container.querySelector('details')!;
    expect(d.open).toBe(false);
    expect(screen.getByText('ⓘ 說明')).toBeTruthy();
  });
});
