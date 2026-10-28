import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { buildReport } from '../../report/buildReport.js';
import { getRecords } from '../../requests/store.js';
import { hasAppFrame } from '../callerComponent.js';
import { queryContextOf } from '../queryContext.js';

// ky 는 타임아웃을 걸려고 new Promise 안의 타이머 콜백에서 fetch 를 부른다. 그때 스택에는 ky 내부만 남는다.
const KY_TIMEOUT_STACK = [
  'at http://localhost:5173/node_modules/.vite/deps/ky.js:209:11',
  'at new Promise (<anonymous>)',
  'at timeout (http://localhost:5173/node_modules/.vite/deps/ky.js:204:9)',
].join('\n');

const Profile = () => {
  useQuery({
    queryKey: ['user', 1],
    // ky 처럼 타이머 안에서 fetch 를 불러 동기 호출 스택이 끊기게 한다.
    queryFn: () =>
      new Promise((resolve, reject) => {
        setTimeout(
          () =>
            fetch('/api/ky-user')
              .then((r) => r.json())
              .then(resolve, reject),
          0,
        );
      }),
  });
  return <p>profile</p>;
};

// ky 처럼 라이브러리 파일(.vite/deps/ky.js)에서 타이머 안에 fetch 를 부르는 코드를 만든다.
const kyLike = new Function(
  'req',
  `return new Promise((resolve) => { setTimeout(() => resolve(fetch(req.clone())), 0); });\n//# sourceURL=http://localhost:5173/node_modules/.vite/deps/ky.js`,
) as (req: Request) => Promise<Response>;

// 앱 함수: 여기서 Request 를 만든다(ky 의 생성자가 앱의 ky.get() 안에서 도는 것과 같다).
const loadKyThing = () => kyLike(new Request('http://localhost/api/ky-origin'));

describe('Request 생성 스택 (#13)', () => {
  it('ky_timeout_path: 타이머 안 fetch(request.clone()) 의 stack 에 앱 함수 프레임이 나온다', async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ a: 1 }));
    await loadKyThing();
    await flush();
    const record = getRecords().find((r) => r.url.endsWith('/api/ky-origin'))!;
    expect(record.stack).toContain('loadKyThing');
    expect(record.noAppFrame).toBeUndefined();
  });

  it('instanceof Request 와 Request.prototype 이 그대로다', () => {
    const request = new Request('http://localhost/x');
    expect(request instanceof Request).toBe(true);
    expect(Object.getPrototypeOf(request)).toBe(Request.prototype);
    expect(request.clone() instanceof Request).toBe(true);
  });
});

describe('비동기 경계를 넘는 요청의 출처 (#13)', () => {
  it('no_app_frame_flag: 라이브러리 프레임뿐이면 앱 프레임이 없다고 알아본다', () => {
    expect(hasAppFrame(KY_TIMEOUT_STACK)).toBe(false);
    expect(hasAppFrame(`${KY_TIMEOUT_STACK}\nat load (http://localhost:5173/src/api.ts:3:4)`)).toBe(true);
    expect(hasAppFrame(undefined)).toBe(false);
  });

  it('ky_timeout_path: 타이머로 끊긴 React Query 요청에 queryKey 와 observer 컴포넌트가 붙고 callers 에 나온다', async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ name: 'kim' }));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Profile />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(getRecords().some((r) => r.url === '/api/ky-user')).toBe(true));
    await flush();
    const record = getRecords().find((r) => r.url === '/api/ky-user')!;
    await waitFor(() => expect(queryContextOf(record)).toEqual({ queryKey: '["user",1]', observer: 'Profile' }));
    const caller = buildReport(false).requests.endpoints.find((e) => e.endpoint === 'GET /api/ky-user')?.callers[0];
    expect(caller).toMatchObject({ queryKey: '["user",1]', observer: 'Profile', component: 'Profile' });
  });

  it('React Query 밖 요청은 undefined', async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ a: 1 }));
    await fetch('/api/plain').then((r) => r.json());
    await flush();
    expect(queryContextOf(getRecords().find((r) => r.url === '/api/plain')!)).toBeUndefined();
  });
});

describe('Request 가로채기 중복 설치 (#13)', () => {
  it('두 번 설치해도 스택이 한 번만 담기고 instanceof 가 그대로다', async () => {
    const { interceptRequestOrigins } = await import('../requestOrigins.js');
    const { requestOrigin } = await import('../requestOrigins.js');
    interceptRequestOrigins();
    const once = globalThis.Request;
    interceptRequestOrigins();
    expect(globalThis.Request).toBe(once);
    const r = new Request('http://l/x');
    expect(r instanceof Request).toBe(true);
    expect(requestOrigin(r)).toBeInstanceOf(Error);
  });
});
