import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_BODY, flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { getRecords } from '../../requests/store.js';
import { collectBoxes } from '../boxes.js';
import { findConsumers } from '../consumers.js';
import { inspect } from '../inspect.js';

type Item = { id: number; title: string };

const Row = ({ item }: { item: { title: string } }) => <li>{item.title}</li>;

const useFetched = <T,>(url: string, pick: (json: typeof DEFAULT_BODY) => T, initial: T) => {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    void fetch(url)
      .then((res) => res.json())
      .then((json) => setValue(pick(json)));
  }, [url, pick]);
  return value;
};

const pickList = (json: typeof DEFAULT_BODY) => json.data.list;
const EffectList = ({ url = '/api/events' }: { url?: string }) => {
  const list = useFetched<Item[]>(url, pickList, []);
  return (
    <ul>
      {list.map((item) => (
        <Row key={item.id} item={item} />
      ))}
    </ul>
  );
};

const withLayout = <T,>(run: () => T): T => {
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 10, 10));
  try {
    return run();
  } finally {
    spy.mockRestore();
  }
};

describe('inspect: 요소 → 컴포넌트 → 요청 → 응답 위치', () => {
  it('useEffect + fetch 로 받은 값의 요청과 경로를 정확히 찾는다', async () => {
    render(<EffectList />);
    const result = inspect(await screen.findByText('메모리 경고'));
    expect(result.components[0].name).toBe('Row');
    expect(result.components[0].hits[0]).toMatchObject({ path: '$.data.list[1]', via: 'props.item', match: 'exact' });
    expect(result.components[0].hits[0].record).toMatchObject({ method: 'GET', url: '/api/events', status: 200 });
  });

  it('useQuery 결과는 queryKey 와 함께 찾는다', async () => {
    const QueryList = () => {
      const { data } = useQuery({ queryKey: ['events', 'p1'], queryFn: () => fetch('/api/q-events').then((r) => r.json()) });
      return (
        <ul>
          {data?.data.list.map((item: Item) => (
            <Row key={item.id} item={item} />
          ))}
        </ul>
      );
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <QueryList />
      </QueryClientProvider>,
    );
    const component = inspect(await screen.findByText('CPU 경고')).components.find((c) => c.name === 'QueryList');
    expect(component?.hits[0]).toMatchObject({ path: '$', via: 'useQuery', queryKey: ['events', 'p1'], match: 'exact' });
  });

  it('가공돼 새 객체가 됐어도 필드 값이 2개 이상 겹치면 파생으로 찾는다', async () => {
    const pickDerived = (json: typeof DEFAULT_BODY) => ({ ...json.data.list[1], label: '가공' });
    const Derived = () => {
      const item = useFetched<Item | null>('/api/derived', pickDerived, null);
      return item ? <Row item={item} /> : null;
    };
    render(<Derived />);
    const result = inspect(await screen.findByText('메모리 경고'));
    expect(result.components[0].hits[0]).toMatchObject({ path: '$.data.list[1]', via: 'props.item', match: 'derived' });
  });

  it('필드 값이 하나만 같으면 파생으로 보지 않고, 화면 글자로 추정한다', async () => {
    const pickTitle = (json: typeof DEFAULT_BODY) => json.data.list[0].title;
    const Single = () => {
      const title = useFetched('/api/single', pickTitle, '');
      return title ? <p>{title}</p> : null;
    };
    render(<Single />);
    const result = inspect(await screen.findByText('CPU 경고'));
    expect(result.components.every((c) => c.hits.length === 0)).toBe(true);
    expect(result.guesses[0]).toMatchObject({ path: '$.data.list[0].title', match: 'text' });
  });

  it('같은 응답 항목의 하위 객체를 여러 props 로 받으면 한 줄로 묶는다', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ list: [{ id: 1, region: { id: 9, name: 'seoul' }, role: { read: true } }] }));
    type Nested = { region: { name: string }; role: object };
    const Panel = ({ region, role }: Nested) => <p data-role={String(!!role)}>{region.name}</p>;
    const pickNested = (json: unknown) => (json as { list: Nested[] }).list[0];
    const Holder = () => {
      const item = useFetched<Nested | null>('/api/nested', pickNested as never, null);
      return item ? <Panel region={item.region} role={item.role} /> : null;
    };
    render(<Holder />);
    expect(inspect(await screen.findByText('seoul')).components[0].hits).toEqual([
      expect.objectContaining({ path: '$.list[0]', via: 'props.region, props.role', match: 'exact' }),
    ]);
  });

  it('출처가 없는 요소는 빈 결과를 돌려준다', () => {
    render(<p>static text that is long enough</p>);
    expect(inspect(screen.getByText('static text that is long enough'))).toEqual({ components: [], guesses: [] });
  });
});

describe('전체 표시 박스', () => {
  it('응답 객체를 props 로 받는 컴포넌트마다 박스를 만들고, 레이아웃이 없으면 그리지 않는다', async () => {
    render(<EffectList />);
    await screen.findByText('메모리 경고');
    expect(collectBoxes(() => false)).toEqual([]);
    expect(withLayout(() => collectBoxes(() => false)).map((b) => [b.name, b.hit.path])).toEqual([
      ['Row', '$.data.list[0]'],
      ['Row', '$.data.list[1]'],
    ]);
  });

  it('commit 이 여러 번 일어나도 지금 화면의 박스만 만든다', async () => {
    const res = await fetch('/api/rows').then((r) => r.json());
    const rows: Item[] = res.data.list;
    const List = ({ count }: { count: number }) => (
      <ul>
        {rows.slice(0, count).map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </ul>
    );
    const view = render(<List count={2} />);
    expect(withLayout(() => collectBoxes(() => false))).toHaveLength(2);
    view.rerender(<List count={1} />);
    expect(withLayout(() => collectBoxes(() => false))).toHaveLength(1);
    view.rerender(<List count={2} />);
    expect(withLayout(() => collectBoxes(() => false))).toHaveLength(2);
  });
});

describe('요청 → 컴포넌트', () => {
  it('요청의 응답 데이터를 쓰는 컴포넌트를 찾는다', async () => {
    render(<EffectList />);
    await screen.findByText('메모리 경고');
    const record = getRecords().find((r) => r.url === '/api/events')!;
    expect(withLayout(() => findConsumers(record, () => false)).map((c) => `${c.name} ${c.via}`)).toEqual([
      'EffectList hook[0]',
      'Row props',
      'Row props',
    ]);
  });
});

describe('StrictMode', () => {
  it('StrictMode 가 effect 를 다시 실행해 생긴 중복은 호출 스택으로 알아본다', async () => {
    const Fetcher = () => {
      useEffect(() => {
        void fetch('/api/strict');
      }, []);
      return null;
    };
    render(
      <StrictMode>
        <Fetcher />
      </StrictMode>,
    );
    await flush();
    const [first, second] = getRecords().filter((r) => r.url === '/api/strict');
    expect(first.strictModeReplay).toBeUndefined();
    expect(second).toMatchObject({ duplicateOf: first.id, strictModeReplay: true });
  });
});

describe('응답이 여러 번 와도 최신 데이터를 가리킨다', () => {
  it('waitFor 로 화면이 바뀐 뒤 다시 검사하면 새 응답을 가리킨다', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { list: [{ id: 1, title: 'first' }] } }));
    const { rerender } = render(<EffectList url="/api/v1" />);
    await screen.findByText('first');
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { list: [{ id: 2, title: 'second' }] } }));
    rerender(<EffectList url="/api/v2" />);
    await waitFor(() => expect(screen.getByText('second')).toBeTruthy());
    expect(inspect(screen.getByText('second')).components[0].hits[0].record.url).toBe('/api/v2');
  });
});
