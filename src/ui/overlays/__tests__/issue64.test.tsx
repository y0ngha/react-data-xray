import { act, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { getRecords } from '../../../core/requests/store.js';
import { renderWithActions } from '../../../testing/withActions.js';
import type { RequestClass } from '../../../core/requests/classify.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { RequestActionsProvider } from '../../contexts.js';
import { useOverlayBoxes } from '../../hooks/useOverlayBoxes.js';
import { color, MATCH_COLOR } from '../../theme.js';
import { SourceOverlay } from '../SourceOverlay.js';

type Item = { id: number };
const Row = ({ item }: { item: Item }) => <li>{item.id}</li>;
/** 첫 응답만 화면에 둔다. 같은 응답이면 이전 객체를 두는 structural sharing 처럼, 출처는 늘 첫 요청이다. */
function List({ url }: { url: string }) {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    void fetch(url)
      .then((r) => r.json())
      .then((json: { data: { list: Item[] } }) => setItems(json.data.list));
  }, [url]);
  return (
    <ul>
      {items.map((i) => (
        <Row key={i.id} item={i} />
      ))}
    </ul>
  );
}

const Boxes = ({ classes, records = getRecords() }: { classes: ReadonlyMap<number, RequestClass>; records?: readonly RequestRecord[] }) => (
  <SourceOverlay boxes={useOverlayBoxes(true, null)} records={records} classes={classes} />
);

/** 같은 밀리초에 나간 요청끼리도 앞뒤가 정해지도록 시각을 순서대로 다시 매긴다. */
const ordered = (url: string): RequestRecord[] => {
  const own = getRecords().filter((r) => r.url === url);
  own.forEach((r, i) => Object.assign(r, { startedAt: 1000 + i * 100 }));
  return own;
};

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 50, 20));
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(40);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(12);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    cb(0);
    return 1;
  });
});
afterEach(() => vi.restoreAllMocks());

const boxColors = (path: RegExp) =>
  screen.getAllByRole('button', { name: path }).map((b) => b.closest<HTMLElement>('[data-color]')?.dataset.color);

/** jsdom 이 정규화한 CSS 값(#f87171 → rgb(...))과 비교하려고 같은 값을 한 번 써 보고 읽는다. */
const cssColor = (value: string, prop: 'background' | 'outline' = 'background'): string => {
  const el = document.createElement('div');
  el.style[prop] = value;
  return el.style[prop];
};

describe('박스 색 (#64)', () => {
  it('출처가 첫 요청(ok)이어도 같은 요청에 같은 응답 재요청이 있으면 박스가 빨강이다', async () => {
    render(<List url="/api/i64" />);
    await act(flush);
    // 화면에 쓰이지 않는 같은 응답 재요청 두 번
    await fetch('/api/i64').then((r) => r.json());
    await fetch('/api/i64').then((r) => r.json());
    const own = ordered('/api/i64');
    expect(own).toHaveLength(3);
    // 출처(첫 요청)의 분류는 ok, 그 뒤 재요청이 같은 응답
    const classes = new Map<number, RequestClass>(own.map((r, i) => [r.id, i === 0 ? 'ok' : 'same-response']));
    renderWithActions(<Boxes classes={classes} />);
    await act(flush);
    expect(screen.getAllByRole('button', { name: /\/api\/i64\s*req ×3 · same response 2/ }).length).toBeGreaterThan(0);
    const colors = boxColors(/\/api\/i64/);
    expect(colors.length).toBeGreaterThan(0);
    expect(colors.every((c) => c === color.warn)).toBe(true);
  });

  it('같은 요청에 낭비가 없으면 여러 번 불려도 매칭 색이다', async () => {
    render(<List url="/api/i64ok" />);
    await act(flush);
    await fetch('/api/i64ok').then((r) => r.json());
    const classes = new Map<number, RequestClass>(getRecords().map((r) => [r.id, 'ok']));
    renderWithActions(<Boxes classes={classes} />);
    await act(flush);
    const colors = boxColors(/\/api\/i64ok\s*req ×2/);
    expect(colors.length).toBeGreaterThan(0);
    expect(colors.every((c) => c === MATCH_COLOR.exact)).toBe(true);
  });

  it('payload(쿼리)가 다른 요청의 낭비는 이 박스 색에 섞지 않는다', async () => {
    render(<List url="/api/i64q?page=1" />);
    await act(flush);
    await fetch('/api/i64q?page=2').then((r) => r.json());
    await fetch('/api/i64q?page=2').then((r) => r.json());
    const page2 = getRecords().filter((r) => r.url.endsWith('page=2'));
    expect(page2).toHaveLength(2);
    const classes = new Map<number, RequestClass>([[page2[1].id, 'duplicate']]);
    renderWithActions(<Boxes classes={classes} />);
    await act(flush);
    const colors = boxColors(/\/api\/i64q/);
    expect(colors.length).toBeGreaterThan(0);
    expect(colors.every((c) => c === MATCH_COLOR.exact)).toBe(true);
  });

  it('새로고침 전 페이지(다른 load)에서 되살린 낭비 기록은 이 박스를 빨갛게 하지 않는다', async () => {
    render(<List url="/api/i64r" />);
    await act(flush);
    const [source] = ordered('/api/i64r');
    // 시각만으로는 걸러지지 않도록 출처보다 늦은 시각을 준다. 다른 페이지의 기록이라 빠져야 한다.
    const restored: RequestRecord = { ...source, id: -1, restored: true, load: (source.load ?? 0) - 1, startedAt: source.startedAt + 50 };
    const classes = new Map<number, RequestClass>([[restored.id, 'duplicate']]);
    renderWithActions(<Boxes classes={classes} records={[restored, ...getRecords()]} />);
    await act(flush);
    // 라벨은 그 요청의 기록 전체(되살린 것 포함)를 센다.
    expect(screen.getAllByRole('button', { name: /\/api\/i64r\s*req ×2 · duplicates 1/ }).length).toBeGreaterThan(0);
    const colors = boxColors(/\/api\/i64r/);
    expect(colors.length).toBeGreaterThan(0);
    expect(colors.every((c) => c === MATCH_COLOR.exact)).toBe(true);
  });

  it('출처가 응답이 바뀐 새 요청이면, 그 앞의 중복은 이 박스를 빨갛게 하지 않는다', async () => {
    // 앞선 두 번(두 번째가 중복)은 화면에 쓰이지 않고, 화면은 그 뒤 요청의 바뀐 응답을 쓴다.
    await fetch('/api/i64n').then((r) => r.json());
    await fetch('/api/i64n').then((r) => r.json());
    mockFetch.mockImplementation(async () => jsonResponse({ data: { list: [{ id: 201 }, { id: 202 }] } }));
    render(<List url="/api/i64n" />);
    await act(flush);
    const own = ordered('/api/i64n');
    expect(own).toHaveLength(3);
    const classes = new Map<number, RequestClass>([[own[1].id, 'duplicate']]);
    renderWithActions(<Boxes classes={classes} />);
    await act(flush);
    const colors = boxColors(/\/api\/i64n\s*req ×3 · duplicates 1/);
    expect(colors.length).toBeGreaterThan(0);
    expect(colors.every((c) => c === MATCH_COLOR.exact)).toBe(true);
  });

  it('처음 그릴 때부터 낭비 색이다(painter 가 칠하기 전 한 프레임도 매칭 색으로 보이지 않는다)', async () => {
    render(<List url="/api/i64m" />);
    await act(flush);
    await fetch('/api/i64m').then((r) => r.json());
    const own = ordered('/api/i64m');
    // painter 의 프레임이 오지 않게 한다.
    vi.mocked(window.requestAnimationFrame).mockImplementation(() => 1);
    renderWithActions(<Boxes classes={new Map<number, RequestClass>([[own[1].id, 'same-response']])} />);
    await act(flush);
    const roots = screen.getAllByRole('button', { name: /\/api\/i64m/ }).map((b) => b.closest<HTMLElement>('[data-color]'));
    expect(roots.length).toBeGreaterThan(0);
    expect(
      roots.every((el) => el?.dataset.color === color.warn && el.style.outline === cssColor(`1px solid ${color.warn}`, 'outline')),
    ).toBe(true);
  });

  it('분류가 나중에 바뀌면 색은 바로, 라벨은 painter 주기에 같은 색인으로 바뀐다', async () => {
    render(<List url="/api/i64u" />);
    await act(flush);
    await fetch('/api/i64u').then((r) => r.json());
    const own = ordered('/api/i64u');
    const view = renderWithActions(<Boxes classes={new Map()} />);
    await act(flush);
    expect(boxColors(/\/api\/i64u/).every((c) => c === MATCH_COLOR.exact)).toBe(true);
    const classes = new Map<number, RequestClass>([[own[1].id, 'same-response']]);
    view.rerender(
      <RequestActionsProvider value={view.actions}>
        <Boxes classes={classes} />
      </RequestActionsProvider>,
    );
    await act(flush);
    expect(boxColors(/\/api\/i64u/).every((c) => c === color.warn)).toBe(true);
    // painter 의 1초 주기
    await act(() => new Promise((resolve) => setTimeout(resolve, 1100)));
    const labels = screen.getAllByRole('button', { name: /\/api\/i64u\s*req ×2 · same response 1/ });
    expect(labels.length).toBeGreaterThan(0);
    // 라벨 바탕도 같은 색이다.
    expect(labels.every((b) => b.style.background === cssColor(color.warn))).toBe(true);
  });
});
