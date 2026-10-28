import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompareReports } from '../compare/CompareReports.js';
import { DEFAULT_DOCK } from '../../hooks/useDockSettings.js';
import { dockAvoiding } from '../panelLayout.js';
import { ResetButton } from '../ResetButton.js';
import { TabReportButton } from '../TabReportButton.js';

afterEach(() => vi.restoreAllMocks());

const rect = (x: number, y: number, w: number, h: number) => new DOMRect(x, y, w, h);

describe('dockAvoiding: 사용자가 조절한 크기로 판단한다 (PR5-5, ponytail PR5-1)', () => {
  const viewport = rect(0, 0, 1000, 800);
  it('패널을 키워 아래에 못 두면 오른쪽으로 간다', () => {
    const modal = rect(100, 50, 300, 400); // bottom 450, right 400
    expect(dockAvoiding(modal, viewport)).toBe('bottom');
    expect(dockAvoiding(modal, viewport, { ...DEFAULT_DOCK, bottomHeight: 400 })).toBe('right');
    expect(dockAvoiding(modal, viewport, { bottomHeight: 400, rightWidth: 700 })).toBe('float');
  });
});

const snap = (components: Array<{ name: string; renders: number; renderedAt?: string }>) => ({
  requests: { endpoints: [{ endpoint: 'GET /x', count: 5, duplicates: 4, sameResponses: 0 }] },
  renders: { monitoring: true, windowSeconds: 10, components: components.map((c) => ({ avoidable: 0, ...c })) },
  reactQuery: { findings: [] },
});

describe('CompareReports', () => {
  it('닫혀 있으면 sessionStorage 를 읽지 않는다 (PR5-10, ponytail PR5-4)', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const { rerender } = render(<CompareReports />);
    rerender(<CompareReports />);
    expect(get).not.toHaveBeenCalled();
  });

  it('상태를 한 번만 쓰고, 같은 이름의 위치별 행에 중복 key 경고가 없다', () => {
    sessionStorage.setItem(
      'rdx:snapshots',
      JSON.stringify({
        before: snap([
          { name: 'Row', renders: 1, renderedAt: 'A.tsx:1' },
          { name: 'Row', renders: 1, renderedAt: 'B.tsx:1' },
        ]),
        after: snap([]),
      }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { container } = render(<CompareReports />);
    fireEvent.click(screen.getByText('비교'));
    fireEvent.change(screen.getByLabelText('전'), { target: { value: 'before' } });
    fireEvent.change(screen.getByLabelText('후'), { target: { value: 'after' } });
    expect(container.textContent?.match(/<Row> A\.tsx:1 removed/g)).toHaveLength(1);
    expect(container.textContent).toContain('B.tsx:1');
    expect(container.textContent?.match(/removed removed/g)).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('TabReportButton (ponytail PR5-8)', () => {
  it('복사하면 알리고, 실패하면 경로를 보인다', async () => {
    const writeText = vi.fn<(t: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<TabReportButton />);
    await act(async () => void fireEvent.click(screen.getByRole('button')));
    expect(screen.getByRole('status').textContent).toBe('복사됨');
    writeText.mockRejectedValue(new Error('denied'));
    await act(async () => void fireEvent.click(screen.getByRole('button')));
    expect(screen.getByRole('status').textContent).toMatch(/^복사 실패: \.rdx\/tabs\/.+\.json$/);
  });
});

describe('ResetButton (ponytail PR5-10)', () => {
  it('지운 시각을 sessionStorage 에서 읽어 새로고침·콘솔 reset 도 반영한다', () => {
    sessionStorage.setItem('rdx:resetAt', JSON.stringify(new Date(2020, 0, 1, 9, 8, 7).getTime()));
    render(<ResetButton />);
    expect(screen.getByText('09:08:07 이후 기록')).toBeTruthy();
  });
});
