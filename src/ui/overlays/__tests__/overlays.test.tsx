import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flush } from '../../../testing/fetchMock.js';
import { getRecords } from '../../../core/requests/store.js';
import { renderWithActions } from '../../../testing/withActions.js';
import { ConsumerHighlight } from '../ConsumerHighlight.js';
import { PickHighlight } from '../PickHighlight.js';
import { SourceOverlay } from '../SourceOverlay.js';

type Item = { id: number; title: string };
const Row = ({ item }: { item: Item }) => <li>{item.title}</li>;
function List() {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    void fetch('/api/overlay')
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
  // jsdom 의 rAF 는 느려서 테스트에서는 바로 실행한다.
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    cb(0);
    return 1;
  });
});
afterEach(() => vi.restoreAllMocks());

describe('오버레이', () => {
  it('전체 표시는 데이터 출처가 있는 컴포넌트마다 URL 라벨을 그리고, 누르면 요청 상세를 연다', async () => {
    render(<List />);
    await act(flush);
    const { actions } = renderWithActions(<SourceOverlay />, (r) => (r.url === '/api/overlay' ? 'duplicate' : 'ok'));
    await act(flush);
    const labels = screen.getAllByRole('button', { name: /\/api\/overlay/ });
    expect(labels).toHaveLength(2);
    fireEvent.click(labels[0]);
    expect(actions.open).toHaveBeenCalledWith(getRecords()[0]);
  });

  it('요청 강조는 그 응답을 쓰는 컴포넌트에 이름을 붙인다', async () => {
    render(<List />);
    await act(flush);
    renderWithActions(<ConsumerHighlight record={getRecords()[0]} />);
    expect(screen.getAllByText('<Row>')).toHaveLength(2);
    expect(screen.getByText('<List>')).toBeTruthy();
  });

  it('요소 선택 강조는 사각형을 그린다', () => {
    const { container } = render(<PickHighlight rect={new DOMRect(1, 2, 3, 4)} />);
    expect((container.firstChild as HTMLElement).style.left).toBe('1px');
  });
});
