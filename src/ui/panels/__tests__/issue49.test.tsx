import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TabReportButton } from '../TabReportButton.js';
import { SnapshotButton } from '../compare/SnapshotButton.js';
import { PanelToolbar } from '../PanelToolbar.js';
import type { RdxReport } from '../../../core/report/buildReport.js';
import { NO_PLUGIN_MESSAGE } from '../../../core/report/reportApi.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.removeItem('react-data-xray:measure');
  sessionStorage.removeItem('rdx:snapshots');
  sessionStorage.removeItem('rdx:snapshotOrder');
  delete window.__RDX__;
});

// PanelToolbar 렌더에 필요한 최소 props
const toolbarProps = {
  activeTab: null as Parameters<typeof PanelToolbar>[0]['activeTab'],
  onTab: vi.fn<(tab: Parameters<typeof PanelToolbar>[0]['activeTab']) => void>(),
  scopeName: null,
  onWholeScreen: vi.fn<() => void>(),
  picking: false,
  onTogglePicking: vi.fn<() => void>(),
  pickTitle: 'Pick',
  boxesVisible: false,
  onToggleBoxes: vi.fn<() => void>(),
  wasteCount: 0,
  dock: 'bottom' as const,
  onDock: vi.fn<(dock: Parameters<typeof PanelToolbar>[0]['dock']) => void>(),
  onClose: vi.fn<() => void>(),
};

describe('Measure 토글 (#49)', () => {
  it('Measure 버튼을 누르면 2줄이 나타나고 sessionStorage 에 저장된다', () => {
    render(<PanelToolbar {...toolbarProps} />);
    // 처음에는 Clear records 가 없다
    expect(screen.queryByText('Clear records')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Measure/ }));

    expect(screen.getByText('Clear records')).toBeTruthy();
    expect(screen.getByText('Save')).toBeTruthy();
    expect(screen.getByText('Compare')).toBeTruthy();
    expect(screen.getByText('Copy report path')).toBeTruthy();
    expect(sessionStorage.getItem('react-data-xray:measure')).toBe('true');
  });

  it('다시 누르면 2줄이 사라지고 false 로 저장된다', () => {
    render(<PanelToolbar {...toolbarProps} />);
    fireEvent.click(screen.getByRole('button', { name: /^Measure/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Measure/ }));
    expect(screen.queryByText('Clear records')).toBeNull();
    expect(sessionStorage.getItem('react-data-xray:measure')).toBe('false');
  });

  it('sessionStorage 에 true 가 있으면 처음부터 펼쳐진 채로 시작한다', () => {
    sessionStorage.setItem('react-data-xray:measure', 'true');
    render(<PanelToolbar {...toolbarProps} />);
    expect(screen.getByText('Clear records')).toBeTruthy();
  });
});

describe('Window 그룹 위치 (#49)', () => {
  it('닫기 버튼(✕)이 DockPicker 아이콘 뒤에 온다', () => {
    render(<PanelToolbar {...toolbarProps} />);
    const all = screen.getAllByRole('button');
    const closeIdx = all.findIndex((b) => b.textContent === '✕');
    const dockIdx = all.findIndex((b) => b.title === 'Dock right');
    expect(dockIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(dockIdx);
  });
});

describe('Copy report path — 버튼 이름 및 경로 (#49)', () => {
  it('버튼이 "Copy report path" 이고 복사 성공 시 "Copied" 를 보인다', async () => {
    const writeText = vi.fn<(t: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<TabReportButton />);
    await act(async () => void fireEvent.click(screen.getByText('Copy report path')));
    expect(screen.getByRole('status').textContent).toBe('Copied');
  });
});

describe('성공 알림 4s 후 사라짐, 실패는 유지 (#49)', () => {
  it('TabReportButton: 성공 알림은 4s 뒤 사라지고 실패 메시지는 유지된다', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn<(t: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<TabReportButton />);
    await act(async () => void fireEvent.click(screen.getByText('Copy report path')));
    expect(screen.getByRole('status').textContent).toBe('Copied');

    // 3.9s 후: 아직 있어야 한다
    act(() => void vi.advanceTimersByTime(3900));
    expect(screen.getByRole('status').textContent).toBe('Copied');

    // 4s 후: 사라진다
    act(() => void vi.advanceTimersByTime(100));
    expect(screen.queryByRole('status')).toBeNull();

    // 실패: 영구 유지
    writeText.mockRejectedValue(new Error('denied'));
    await act(async () => void fireEvent.click(screen.getByText('Copy report path')));
    expect(screen.getByRole('status').textContent).toMatch(/^Copy failed:/);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('status').textContent).toMatch(/^Copy failed:/);
  });

  it('SnapshotButton: 성공 알림은 4s 뒤 사라진다', async () => {
    vi.useFakeTimers();
    const makeReport = (): RdxReport =>
      ({
        generatedAt: '',
        resetAt: null,
        page: '/',
        howToRead: [],
        requests: { total: 0, dropped: 0, endpoints: [], review: [] },
        reactQuery: { findings: [] },
        renders: { monitoring: true, windowSeconds: 10, truncated: false, droppedInstances: 0, components: [] },
      }) as never;
    const report = makeReport();
    window.__RDX__ = {
      report: vi.fn<() => RdxReport>(() => report),
      reset: vi.fn<() => void>(),
      snapshot: vi.fn<(name: string) => Promise<RdxReport>>(async () => {
        throw new Error(NO_PLUGIN_MESSAGE);
      }),
      compare: vi.fn<() => Promise<import('../../../core/report/compare.js').ReportComparison>>(async () => ({
        requests: [],
        renders: [],
        reactQuery: { added: [], resolved: [] },
        warnings: [],
      })),
    };

    render(<SnapshotButton />);
    fireEvent.click(screen.getByText('Save'));
    await act(async () => void fireEvent.click(screen.getByTitle('Save snapshot')));

    expect(screen.getByText(/Tab only/)).toBeTruthy();

    // 4s 후 사라진다
    act(() => void vi.advanceTimersByTime(4000));
    expect(screen.queryByText(/Tab only/)).toBeNull();
  });
});
