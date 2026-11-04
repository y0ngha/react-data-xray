import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { flush } from '../../testing/fetchMock.js';
import { RdxDevtools } from '../RdxDevtools.js';
import { FloatingButton } from '../FloatingButton.js';
import { stormItems, type RenderStorm } from '../../core/problems.js';
import { useProblemSignal } from '../hooks/useProblemSignal.js';
import { focusedRenderRow } from '../viewState.js';

const handlers = { onPointerDown: () => undefined, onPointerMove: () => undefined, onPointerUp: () => undefined, onClick: () => undefined };
const breakdown = { waste: ['GET /a', 'GET /b'], storming: [{ name: 'Comp', key: 'Comp|' }] };
const setup = (onSelect = vi.fn<(tab: string, key: string, fallbacks?: readonly string[]) => void>()) => {
  render(
    <FloatingButton position={{ x: 0, y: 0 }} issues={3} alert={false} handlers={handlers} breakdown={breakdown} onSelect={onSelect} />,
  );
  return { onSelect, button: screen.getByRole('button', { name: /Open React Data X-ray/ }) };
};

afterEach(() => vi.useRealTimers());

it('keyboard_focus: 포커스로도 내역이 열리고, 바깥으로 포커스가 나가면 닫힌다', () => {
  const { button } = setup();
  expect(screen.queryByText(/wasted requests 2/)).toBeNull();
  fireEvent.focus(button);
  expect(screen.getByText(/wasted requests 2/)).toBeTruthy();
  expect(screen.getByText(/render storm 1/)).toBeTruthy();
  fireEvent.blur(button, { relatedTarget: document.body });
  expect(screen.queryByText(/낭비 요청 2/)).toBeNull();
});

it('마우스를 올려도 열리고, 항목을 누르면 해당 탭으로 가며 닫힌다', () => {
  const { button, onSelect } = setup();
  fireEvent.mouseEnter(button);
  fireEvent.click(screen.getByRole('button', { name: 'GET /b' }));
  expect(onSelect).toHaveBeenCalledWith('requests', 'GET /b');
  fireEvent.mouseEnter(button);
  fireEvent.click(screen.getByRole('button', { name: '<Comp>' }));
  expect(onSelect).toHaveBeenLastCalledWith('renders', 'Comp|');
});

it('storm_rows: 같은 이름이 두 위치에서 폭주하면 배지 수만큼 줄을 두고 위치로 가르며, 누르면 그 그룹 키로 간다', () => {
  const onSelect = vi.fn<(tab: string, key: string, fallbacks?: readonly string[]) => void>();
  const storming = stormItems(
    new Map<string, RenderStorm>([
      ['Row|src/List.tsx:12', { name: 'Row', location: 'src/List.tsx:12', recent: 12 }],
      ['Row|src/Grid.tsx:3', { name: 'Row', location: 'src/Grid.tsx:3', recent: 15 }],
      ['ag|Cell||Grid|src/App.tsx:5', { name: 'Cell', package: 'ag', owner: { name: 'Grid', location: 'src/App.tsx:5' }, recent: 20 }],
    ]),
  );
  render(
    <FloatingButton
      position={{ x: 0, y: 0 }}
      issues={3}
      alert={false}
      handlers={handlers}
      breakdown={{ waste: [], storming }}
      onSelect={onSelect}
    />,
  );
  const button = screen.getByRole('button', { name: /Open React Data X-ray/ });
  fireEvent.mouseEnter(button);
  expect(screen.getByText(/render storm 3/)).toBeTruthy();
  // 이름이 하나뿐인 그룹은 위치를 붙이지 않는다
  expect(screen.getByRole('button', { name: '<Cell>' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '<Row> · src/List.tsx:12' }));
  expect(onSelect).toHaveBeenLastCalledWith('renders', 'Row|src/List.tsx:12');
  fireEvent.mouseEnter(button);
  fireEvent.click(screen.getByRole('button', { name: '<Cell>' }));
  // 라이브러리 그룹이 앱 컴포넌트 행에 접혔으면 그 행으로 간다
  expect(onSelect).toHaveBeenLastCalledWith('renders', 'ag|Cell||Grid|src/App.tsx:5', ['Grid|src/App.tsx:5']);
});

it('focused_render_row: 렌더 탭은 그룹 키, 그다음 대신 키, 그다음 이름으로 행을 찾는다', () => {
  const groups = [
    { name: 'Row', key: 'Row|src/Grid.tsx:3' },
    { name: 'Row', key: 'Row|src/List.tsx:12' },
    { name: 'Grid', key: 'Grid|src/App.tsx:5' },
  ];
  expect(focusedRenderRow(groups, { tab: 'renders', key: 'Row|src/List.tsx:12' })).toBe(1);
  expect(focusedRenderRow(groups, { tab: 'renders', key: 'ag|Cell||Grid|src/App.tsx:5', fallbacks: ['Grid|src/App.tsx:5'] })).toBe(2);
  expect(focusedRenderRow(groups, { tab: 'renders', key: 'Row' })).toBe(0);
});

it('storm_window_note: 렌더 폭주가 최근 10초 기준이라고 적는다', () => {
  const { button } = setup();
  fireEvent.mouseEnter(button);
  expect(screen.getByText(/last 10s/)).toBeTruthy();
});

it('문제가 없으면 내역을 열지 않는다', () => {
  render(
    <FloatingButton
      position={{ x: 0, y: 0 }}
      issues={0}
      alert={false}
      handlers={handlers}
      breakdown={{ waste: [], storming: [] }}
      onSelect={vi.fn<(tab: string, key: string) => void>()}
    />,
  );
  fireEvent.mouseEnter(screen.getByRole('button'));
  expect(screen.queryByText(/last 10s/)).toBeNull();
});

it('useProblemSignal 이 낭비 엔드포인트 이름을 개수와 함께 돌려준다', () => {
  vi.useFakeTimers();
  const { result } = renderHook(() =>
    useProblemSignal([], () => 'ok', [
      { endpoint: 'GET /a', duplicates: 1, sameResponses: 0 },
      { endpoint: 'GET /b', duplicates: 0, sameResponses: 2 },
      { endpoint: 'GET /ok', duplicates: 0, sameResponses: 0 },
    ]),
  );
  expect(result.current.wasteEndpoints).toEqual(['GET /a', 'GET /b']);
  expect(result.current.issues).toBe(2);
  expect(result.current.storming).toEqual([]);
  act(() => void vi.advanceTimersByTime(1000));
});

it('RdxDevtools: 배지에 올리면 내역이 뜨고, 항목을 누르면 그 탭이 열린다', async () => {
  await fetch('/api/a');
  await fetch('/api/a');
  render(<RdxDevtools />);
  await act(flush);
  const button = screen.getByRole('button', { name: /Open React Data X-ray/ });
  await waitFor(() => expect(button.textContent).toBe('RDX1'));
  fireEvent.mouseEnter(button);
  fireEvent.click(screen.getByRole('button', { name: 'GET /api/a' }));
  expect(screen.getByRole('complementary', { name: 'React Data X-ray' })).toBeTruthy();
  expect(screen.getByText('By endpoint')).toBeTruthy();
});

it('배지 내역에서 GET /api/b 를 누르면 요청 탭이 열리고 그 줄에 포커스가 있다', async () => {
  await fetch('/api/a');
  await fetch('/api/a');
  await fetch('/api/b');
  await fetch('/api/b');
  render(<RdxDevtools />);
  await act(flush);
  const button = screen.getByRole('button', { name: /Open React Data X-ray/ });
  await waitFor(() => expect(button.textContent).toBe('RDX2'));
  fireEvent.mouseEnter(button);
  fireEvent.click(screen.getByRole('button', { name: 'GET /api/b' }));
  const row = screen.getByRole('button', { name: 'GET /api/b' }).closest('div[tabindex="-1"]');
  expect(row).toBeTruthy();
  expect(document.activeElement).toBe(row);
});
