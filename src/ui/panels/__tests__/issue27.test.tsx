import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { getTabId } from '../../../core/report/reportApi.js';
import { TabReportButton } from '../TabReportButton.js';

it('패널이 이 탭의 id 를 보이고 보고서 경로를 복사한다', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  Object.assign(navigator, { clipboard: { writeText } });
  render(<TabReportButton />);
  fireEvent.click(screen.getByText(`Tab ${getTabId()}`));
  expect(writeText).toHaveBeenCalledWith(`.rdx/tabs/${getTabId()}.json`);
  expect(getTabId()).toBe(getTabId());
});
