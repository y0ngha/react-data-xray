import { act, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { mockFetch, jsonResponse } from '../../testing/fetchMock.js';
import { getTopRenders, setRenderMonitoring } from '../render/monitor.js';
import { getOrigin } from '../requests/origins.js';
import { flushQueue } from '../scheduler/idleQueue.js';

describe('앱 경로는 분석하지 않고, 큐가 같은 결과를 낸다', () => {
  it('fetch_json_setstate_commit: flush 전에는 출처도 렌더 기록도 없고, flush 뒤에 직접 원인이 붙는다', async () => {
    setRenderMonitoring(true);
    try {
      let body: object | undefined;
      const Widget = () => {
        const [data, setData] = useState<object>();
        useEffect(() => {
          void fetch('/api/x')
            .then((res) => res.json())
            .then((json: object) => {
              body = json;
              setData(json);
            });
        }, []);
        return <p>{data ? 'loaded' : 'loading'}</p>;
      };
      mockFetch.mockImplementation(async () => jsonResponse({ a: [1, 2] }));
      const view = render(<Widget />);
      await act(async () => {
        // 타이머를 쓰면 한가한 틱의 큐가 먼저 돌 수 있어, 마이크로태스크로만 기다린다.
        for (let i = 0; i < 50; i++) {
          if (body) break;
          await Promise.resolve();
        }
      });
      expect(view.getByText('loaded')).toBeTruthy();
      expect(getOrigin(body!)).toBeUndefined();
      expect(getTopRenders()).toEqual([]);

      flushQueue();
      const widget = getTopRenders().find((e) => e.name === 'Widget');
      const last = widget?.events[widget.events.length - 1];
      expect(last?.reason).toBe('state');
      expect(last?.cause?.via).toBe('direct');
      expect(last?.cause?.record.url).toBe('/api/x');
    } finally {
      setRenderMonitoring(false);
    }
  });

  it('app_values_untouched: json() 결과는 앱이 받은 그 객체이고 JSON.parse 결과와 같다', async () => {
    const res = jsonResponse({ a: [1, 2] });
    mockFetch.mockImplementation(async () => res);
    const got = (await (await fetch('/api/y')).json()) as object;
    expect(got).toEqual(JSON.parse('{"a":[1,2]}'));
    expect(await Promise.resolve(got)).toBe(got);
    flushQueue();
  });
});
