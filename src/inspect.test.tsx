import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { install } from './capture';
import { inspect } from './inspect';
import { clearRecords } from './registry';

const body = { data: { list: [{ id: 1, title: 'CPU 경고' }, { id: 2, title: '메모리 경고' }] } };

beforeAll(() => {
  // jsdom 에는 fetch 가 없어서, 설치 전에 가짜 fetch 를 둔다.
  window.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  install();
});

beforeEach(() => clearRecords());
afterEach(() => cleanup());

const Row = ({ item }: { item: { title: string } }) => <li>{item.title}</li>;

const EffectList = () => {
  const [list, setList] = useState<Array<{ id: number; title: string }>>([]);
  useEffect(() => {
    fetch('/api/events')
      .then((res) => res.json())
      .then((json) => setList(json.data.list));
  }, []);
  return (
    <ul>
      {list.map((item) => (
        <Row key={item.id} item={item} />
      ))}
    </ul>
  );
};

const QueryList = () => {
  const { data } = useQuery({ queryKey: ['events', 'p1'], queryFn: () => fetch('/api/q-events').then((r) => r.json()) });
  return <ul>{data?.data.list.map((item: { id: number; title: string }) => <Row key={item.id} item={item} />)}</ul>;
};

const Transformed = () => {
  const [titles, setTitles] = useState<string[]>([]);
  useEffect(() => {
    fetch('/api/transformed')
      .then((res) => res.json())
      .then((json) => setTitles(json.data.list.map((i: { title: string }) => i.title)));
  }, []);
  return <p>{titles[1]}</p>;
};

describe('inspect', () => {
  it('useEffect + fetch 로 받은 값의 요청과 경로를 정확히 찾는다', async () => {
    render(<EffectList />);
    const li = await screen.findByText('메모리 경고');

    const result = inspect(li);

    expect(result.components[0].name).toBe('Row');
    expect(result.components[0].hits[0]).toMatchObject({ path: '$.data.list[1]', via: 'props.item', exact: true });
    expect(result.components[0].hits[0].record).toMatchObject({ method: 'GET', url: '/api/events', status: 200 });
  });

  it('useQuery 결과는 queryKey 와 함께 찾는다', async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <QueryList />
      </QueryClientProvider>,
    );
    const li = await screen.findByText('CPU 경고');

    const queryList = inspect(li).components.find((c) => c.name === 'QueryList');

    expect(queryList?.hits[0]).toMatchObject({ path: '$', via: 'useQuery', queryKey: ['events', 'p1'], exact: true });
  });

  it('가공돼 참조가 끊긴 값은 화면 글자로 추정한다', async () => {
    render(<Transformed />);
    const p = await screen.findByText('메모리 경고');

    const result = inspect(p);

    expect(result.components.every((c) => c.hits.length === 0)).toBe(true);
    expect(result.guesses[0]).toMatchObject({ path: '$.data.list[1].title', exact: false });
  });

  it('res.text() 후 JSON.parse 해도(axios 방식) 참조를 등록한다', async () => {
    const Text = () => {
      const [item, setItem] = useState<{ title: string } | null>(null);
      useEffect(() => {
        fetch('/api/text')
          .then((res) => res.text())
          .then((text) => setItem(JSON.parse(text).data.list[0]));
      }, []);
      return item ? <Row item={item} /> : null;
    };
    render(<Text />);
    const li = await screen.findByText('CPU 경고');

    await waitFor(() => expect(inspect(li).components[0].hits[0]).toMatchObject({ path: '$.data.list[0]', exact: true }));
  });
});
