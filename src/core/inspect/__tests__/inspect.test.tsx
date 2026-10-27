import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_BODY, flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { getRecords } from '../../requests/store.js';
import { collectBoxes } from '../boxes.js';
import { flushIndex } from '../derivedMatch.js';
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

  it('이름이 같은 조상 컴포넌트가 여러 개여도 깊이로 구분한다', async () => {
    const Wrap = ({ item, children }: { item: object; children: React.ReactNode }) => <div data-x={String(!!item)}>{children}</div>;
    const pickPair = (json: typeof DEFAULT_BODY) => json.data.list;
    const Nested = () => {
      const list = useFetched<Item[]>('/api/pair', pickPair, []);
      return list.length ? (
        <Wrap item={list[0]}>
          <Wrap item={list[1]}>
            <span>inner</span>
          </Wrap>
        </Wrap>
      ) : null;
    };
    render(<Nested />);
    const result = inspect(await screen.findByText('inner'));
    expect(result.components.filter((c) => c.name === 'Wrap').map((c) => c.depth)).toEqual([0, 1]);
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
    expect(collectBoxes(() => false).boxes).toEqual([]);
    expect(withLayout(() => collectBoxes(() => false).boxes).map((b) => [b.name, b.hit.path])).toEqual([
      ['Row', '$.data.list[0]'],
      ['Row', '$.data.list[1]'],
    ]);
  });

  it('파생 조회 시간을 넘기면 미뤘다고 알리고, 다음 수집에서 이어서 찾는다', async () => {
    const pickDerived = (json: typeof DEFAULT_BODY) => ({ ...json.data.list[0], label: '가공' });
    const Derived = () => {
      const item = useFetched<Item | null>('/api/derived-box', pickDerived, null);
      return item ? <Row item={item} /> : null;
    };
    render(<Derived />);
    await screen.findByText('CPU 경고');
    const first = withLayout(() => collectBoxes(() => false, -1));
    expect(first).toEqual({ boxes: [], deferred: true });
    const next = withLayout(() => collectBoxes(() => false, Infinity));
    expect(next.deferred).toBe(false);
    expect(next.boxes.map((b) => [b.name, b.hit.match])).toEqual([['Row', 'derived']]);
  });

  it('카드마다 항목 단위로 한 번, 다른 응답의 복사본은 그 안에서 한 번만 그린다', async () => {
    type Project = { id: number; status: { up: number }; region: { name: string } };
    mockFetch.mockImplementationOnce(async () =>
      jsonResponse({ data: { projects: [{ id: 1, status: { up: 1 }, region: { name: 'kr' } }] } }),
    );
    const project: Project = await fetch('/api/projects')
      .then((r) => r.json())
      .then((json) => json.data.projects[0]);
    mockFetch.mockImplementationOnce(async () => jsonResponse({ total: 3, normal: 2, paused: 0 }));
    const summary = await fetch('/api/summary').then((r) => r.json());
    const stat = { ...summary, before: {} };
    const Total = ({ stat: s }: { stat: { total: number } }) => <b>{s.total}</b>;
    const Body = ({ item, stat: s }: { item: Project; stat: { total: number } }) => (
      <div>
        {item.id} <Total stat={s} />
      </div>
    );
    const Region = ({ region }: { region: Project['region'] }) => <i>{region.name}</i>;
    const Card = ({ status, item }: { status: Project['status']; item: Project }) => (
      <section>
        {status.up} <Region region={item.region} /> <Body item={item} stat={stat} />
      </section>
    );
    render(<Card status={project.status} item={project} />);
    expect(withLayout(() => collectBoxes(() => false).boxes).map((b) => [b.name, b.hit.record.url, b.hit.match])).toEqual([
      ['Card', '/api/projects', 'exact'],
      ['Body', '/api/summary', 'derived'],
    ]);
  });

  it('큰 응답의 색인이 덜 끝나 못 찾았으면 미뤘다고 알리고, 색인이 끝나면 찾는다', async () => {
    const list = Array.from({ length: 30_000 }, (_, i) => ({ id: 70_000 + i, title: `item-${i}` }));
    mockFetch.mockImplementationOnce(async () => jsonResponse({ list }));
    const json: { list: Item[] } = await fetch('/api/big-derived').then((r) => r.json());
    const Copy = ({ item }: { item: Item }) => <p>{item.title}</p>;
    render(<Copy item={{ ...json.list[29_999], title: json.list[29_999].title }} />);
    const first = withLayout(() => collectBoxes(() => false));
    expect(first.deferred).toBe(true);
    flushIndex();
    expect(withLayout(() => collectBoxes(() => false)).boxes.map((b) => [b.name, b.hit.match])).toEqual([['Copy', 'derived']]);
  });

  it('목록 밖 경로($.data)를 받은 조상 아래의 목록 행은 행마다 그린다', async () => {
    const json: typeof DEFAULT_BODY = await fetch('/api/dashboard').then((r) => r.json());
    const Dashboard = ({ data }: { data: typeof DEFAULT_BODY.data }) => (
      <ul>
        {data.list.map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </ul>
    );
    render(<Dashboard data={json.data} />);
    expect(withLayout(() => collectBoxes(() => false).boxes).map((b) => [b.name, b.hit.path])).toEqual([
      ['Dashboard', '$.data'],
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
    expect(withLayout(() => collectBoxes(() => false).boxes)).toHaveLength(2);
    view.rerender(<List count={1} />);
    expect(withLayout(() => collectBoxes(() => false).boxes)).toHaveLength(1);
    view.rerender(<List count={2} />);
    expect(withLayout(() => collectBoxes(() => false).boxes)).toHaveLength(2);
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
