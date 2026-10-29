import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { getTabId } from '../../../core/report/reportApi.js';
import { TabReportButton } from '../TabReportButton.js';

it('패널이 탭 id 를 title 에 보이고 보고서 경로를 복사한다', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  Object.assign(navigator, { clipboard: { writeText } });
  render(<TabReportButton />);
  // 버튼 label 은 "Copy report path"; 탭 id 와 경로는 title 에 있다
  const btn = screen.getByText('Copy report path');
  expect(btn.closest('button')?.title).toContain(getTabId());
  fireEvent.click(btn);
  expect(writeText).toHaveBeenCalledWith(`.rdx/tabs/${getTabId()}.json`);
});
