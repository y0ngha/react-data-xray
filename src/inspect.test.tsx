import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useEffect, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { install, serializeBody } from './capture.js';
import { collectBoxes, inspect } from './inspect.js';
import { clearRecords, getRecords } from './registry.js';

// 파생 매칭은 의미 있는 필드 값이 2개 이상 같아야 하므로 id 를 두 자리 이상으로 둔다.
const body = { data: { list: [{ id: 101, title: 'CPU 경고' }, { id: 102, title: '메모리 경고' }] } };

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
// jsdom 에는 fetch 가 없어서, 설치 전에 가짜 fetch 를 둔다. install() 뒤에는 window.fetch 가 래퍼라 이 참조로 조작한다.
const mockFetch = vi.fn(async () => jsonResponse(body));

beforeAll(() => {
  window.fetch = mockFetch;
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
    expect(result.components[0].hits[0]).toMatchObject({ path: '$.data.list[1]', via: 'props.item', match: 'exact' });
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

    expect(queryList?.hits[0]).toMatchObject({ path: '$', via: 'useQuery', queryKey: ['events', 'p1'], match: 'exact' });
  });

  it('가공돼 참조가 끊긴 값은 화면 글자로 추정한다', async () => {
    render(<Transformed />);
    const p = await screen.findByText('메모리 경고');

    const result = inspect(p);

    expect(result.components.every((c) => c.hits.length === 0)).toBe(true);
    expect(result.guesses[0]).toMatchObject({ path: '$.data.list[1].title', match: 'text' });
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

    await waitFor(() => expect(inspect(li).components[0].hits[0]).toMatchObject({ path: '$.data.list[0]', match: 'exact' }));
  });

  it('가공돼 새 객체가 됐어도 필드 값이 겹치면 파생으로 찾는다', async () => {
    const Derived = () => {
      const [item, setItem] = useState<{ id: number; title: string; label: string } | null>(null);
      useEffect(() => {
        fetch('/api/derived')
          .then((res) => res.json())
          .then((json) => setItem({ ...json.data.list[1], label: '가공' }));
      }, []);
      return item ? <Row item={item} /> : null;
    };
    render(<Derived />);
    const li = await screen.findByText('메모리 경고');

    expect(inspect(li).components[0].hits[0]).toMatchObject({ path: '$.data.list[1]', via: 'props.item', match: 'derived' });
  });

  it('2초 안의 같은 요청은 중복, 직전과 같은 응답은 같은 응답 재요청으로 표시한다', async () => {
    await fetch('/api/dup').then((r) => r.json());
    await fetch('/api/dup').then((r) => r.json());
    // 같은 응답 비교는 응답을 복제해 비동기로 읽으므로 한 틱 기다린다.
    await new Promise((r) => setTimeout(r, 0));

    const [first, second] = getRecords().filter((r) => r.url === '/api/dup');
    expect(first.duplicateOf).toBeUndefined();
    expect(second.duplicateOf).toBe(first.id);
    expect(second.sameResponseAs).toBe(first.id);
  });

  it('쿼리스트링이 다른 요청은 응답이 같아도 같은 응답 재요청으로 보지 않는다', async () => {
    await fetch('/api/page?p=1').then((r) => r.json());
    await fetch('/api/page?p=2').then((r) => r.json());
    await new Promise((r) => setTimeout(r, 0));

    const [, second] = getRecords().filter((r) => r.url.startsWith('/api/page'));
    expect(second.duplicateOf).toBeUndefined();
    expect(second.sameResponseAs).toBeUndefined();
  });

  it('payload 가 다르면 중복이 아니고, 쿼리 순서만 다르면 중복이다', async () => {
    await fetch('/api/search', { method: 'POST', body: JSON.stringify({ q: 'a' }) });
    await fetch('/api/search', { method: 'POST', body: JSON.stringify({ q: 'b' }) });
    await fetch('/api/list?a=1&b=2');
    await fetch('/api/list?b=2&a=1');

    const [a, b] = getRecords().filter((r) => r.url === '/api/search');
    const [l1, l2] = getRecords().filter((r) => r.url.startsWith('/api/list'));
    expect(a.requestBody).toBe('{"q":"a"}');
    expect(b.duplicateOf).toBeUndefined();
    expect(l2.duplicateOf).toBe(l1.id);
  });

  it('읽을 수 없는 payload 는 중복 판정에서 뺀다', async () => {
    await fetch('/api/upload', { method: 'POST', body: new Blob(['x']) });
    await fetch('/api/upload', { method: 'POST', body: new Blob(['x']) });

    const [, second] = getRecords().filter((r) => r.url === '/api/upload');
    expect(second.bodyUnreadable).toBe(true);
    expect(second.duplicateOf).toBeUndefined();
  });

  it('FormData, URLSearchParams 는 내용으로 비교한다', () => {
    const form = new FormData();
    form.append('name', 'cpu');
    form.append('file', new File(['abc'], 'a.txt'));
    expect(serializeBody(form)).toBe('name=cpu&file=[file a.txt 3B]');
    expect(serializeBody(new URLSearchParams({ a: '1' }))).toBe('a=1');
  });

  it('같은 응답 항목의 하위 객체를 여러 props 로 받으면 한 줄로 묶는다', async () => {
    const nested = { data: { list: [{ id: 1, region: { id: 9, name: 'seoul' }, role: { read: true } }] } };
    mockFetch.mockResolvedValueOnce(jsonResponse(nested));
    const Panel = ({ region, role }: { region: { name: string }; role: object }) => <p data-role={String(!!role)}>{region.name}</p>;
    const Nested = () => {
      const [item, setItem] = useState<(typeof nested)['data']['list'][0] | null>(null);
      useEffect(() => {
        fetch('/api/nested')
          .then((r) => r.json())
          .then((json) => setItem(json.data.list[0]));
      }, []);
      return item ? <Panel region={item.region} role={item.role} /> : null;
    };
    render(<Nested />);
    const p = await screen.findByText('seoul');

    expect(inspect(p).components[0].hits).toEqual([
      expect.objectContaining({ path: '$.data.list[0]', via: 'props.region, props.role', match: 'exact' }),
    ]);
  });

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
    await new Promise((r) => setTimeout(r, 0));

    const [first, second] = getRecords().filter((r) => r.url === '/api/strict');
    expect(first.strictModeReplay).toBeUndefined();
    expect(second).toMatchObject({ duplicateOf: first.id, strictModeReplay: true });
  });

  it('전체 표시는 commit 이 여러 번 일어나도 현재 화면의 박스만 만든다', async () => {
    const rows = body.data.list;
    const List = ({ count }: { count: number }) => (
      <ul>
        {rows.slice(0, count).map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </ul>
    );
    await fetch('/api/rows').then((r) => r.json());
    // 응답 객체를 등록하려면 같은 참조를 써야 하므로, 방금 받은 응답으로 행을 그린다.
    const registered = getRecords().find((r) => r.url === '/api/rows')!.body as typeof body;
    rows.splice(0, rows.length, ...registered.data.list);
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 10, 10));

    const view = render(<List count={2} />);
    expect(collectBoxes(() => false)).toHaveLength(2);
    view.rerender(<List count={1} />);
    expect(collectBoxes(() => false)).toHaveLength(1);
    view.rerender(<List count={2} />);
    expect(collectBoxes(() => false)).toHaveLength(2);
    spy.mockRestore();
  });

  it('필드 값이 하나만 같으면 파생으로 보지 않는다', async () => {
    const Single = () => {
      const [style, setStyle] = useState<{ title: string; extra: number } | null>(null);
      useEffect(() => {
        fetch('/api/single')
          .then((r) => r.json())
          .then((json) => setStyle({ title: json.data.list[0].title, extra: 3 }));
      }, []);
      return style ? <p data-x={style.extra}>{`제목 ${style.title}`}</p> : null;
    };
    render(<Single />);
    const p = await screen.findByText('제목 CPU 경고');

    expect(inspect(p).components.every((c) => c.hits.every((h) => h.match !== 'derived'))).toBe(true);
  });

  it('전체 표시는 응답 객체를 props 로 받는 컴포넌트마다 박스를 만든다', async () => {
    render(<EffectList />);
    await screen.findByText('메모리 경고');

    const boxes = collectBoxes(() => false);

    // jsdom 은 레이아웃이 없어 크기가 0 이므로 박스 대상만 확인한다.
    expect(boxes).toEqual([]);
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 10, 10));
    const withLayout = collectBoxes(() => false);
    spy.mockRestore();
    expect(withLayout.map((b) => [b.name, b.hit.path])).toEqual([
      ['Row', '$.data.list[0]'],
      ['Row', '$.data.list[1]'],
    ]);
  });
});
