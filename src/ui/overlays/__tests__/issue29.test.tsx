import { act, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flush } from '../../../testing/fetchMock.js';
import { getRecords } from '../../../core/requests/store.js';
import { renderWithActions } from '../../../testing/withActions.js';
import type { RequestClass } from '../../../core/requests/classify.js';
import { useOverlayBoxes } from '../../hooks/useOverlayBoxes.js';
import { SourceOverlay } from '../SourceOverlay.js';

const Boxes = () => <SourceOverlay boxes={useOverlayBoxes(true, null)} records={getRecords()} classes={new Map<number, RequestClass>()} />;

type Item = { id: number };
const Row = ({ item }: { item: Item }) => <li>{item.id}</li>;
function List() {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    void fetch('/api/i29')
      .then((r) => r.json())
      .then((json: { data: { list: Item[] } }) => setItems(json.data.list));
  }, []);
  return (
    <ul>
      {items.map((i) => (
        <Row key={i.id} item={i} />
      ))}
    </ul>
  );
}

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

describe('박스 라벨 (#29)', () => {
  it('요청 지표 앞에 "요청" 을 붙여 렌더 지표와 말로 구분한다', async () => {
    render(<List />);
    await act(flush);
    await fetch('/api/i29').then((r) => r.json());
    renderWithActions(<Boxes />, (r) => (r.url === '/api/i29' ? 'duplicate' : 'ok'));
    await act(flush);
    expect(screen.getAllByRole('button', { name: /\/api\/i29\s*req ×2/ }).length).toBeGreaterThan(0);
  });

  it('라벨 title 에 지표 설명이 있다', async () => {
    render(<List />);
    await act(flush);
    renderWithActions(<Boxes />);
    await act(flush);
    expect(screen.getAllByRole('button')[0].title).toContain('renders N = render count of components using this response');
  });

  it('overlap_labels: 같은 자리의 두 박스 라벨은 서로 붙지 않는다', async () => {
    render(<List />);
    await act(flush);
    renderWithActions(<Boxes />);
    await act(flush);
    await act(async () => window.dispatchEvent(new Event('resize')));
    const tops = screen.getAllByRole('button').map((b) => parseFloat(b.style.top));
    expect(tops).toHaveLength(2);
    expect(Math.abs(tops[0] - tops[1])).toBeGreaterThanOrEqual(12 + 3);
  });
});
