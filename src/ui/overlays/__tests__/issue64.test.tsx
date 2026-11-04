import { act, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flush } from '../../../testing/fetchMock.js';
import { getRecords } from '../../../core/requests/store.js';
import { renderWithActions } from '../../../testing/withActions.js';
import type { RequestClass } from '../../../core/requests/classify.js';
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

const Boxes = ({ classes }: { classes: ReadonlyMap<number, RequestClass> }) => (
  <SourceOverlay boxes={useOverlayBoxes(true, null)} records={getRecords()} classes={classes} />
);

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

describe('박스 색 (#64)', () => {
  it('출처가 첫 요청(ok)이어도 같은 요청에 같은 응답 재요청이 있으면 박스가 빨강이다', async () => {
    render(<List url="/api/i64" />);
    await act(flush);
    // 화면에 쓰이지 않는 같은 응답 재요청 두 번
    await fetch('/api/i64').then((r) => r.json());
    await fetch('/api/i64').then((r) => r.json());
    const own = getRecords().filter((r) => r.url === '/api/i64');
    expect(own).toHaveLength(3);
    const classes = new Map<number, RequestClass>(own.map((r, i) => [r.id, i === 0 ? 'ok' : 'same-response']));
    // 출처 요청 하나의 분류는 ok
    renderWithActions(<Boxes classes={classes} />, (r) => classes.get(r.id) ?? 'ok');
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
});
