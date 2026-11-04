import { act, cleanup, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { currentCommitSeq } from '../../render/commitCauses.js';
import { resetRenderStats, setRenderMonitoring } from '../../render/monitor.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { repeatCauseStep } from '../repeatCause.js';
import type { RequestRecord } from '../types.js';

// 요청을 보낸 시점. 실제 fetch 대신, 요청을 만들 때 담는 값(시각·commit 순번)을 effect 에서 적는다.
type Sent = Pick<RequestRecord, 'startedAt' | 'commitSeq'>;
let sent: Sent[] = [];
let ids: number[] = [];
let setLoading: (v: boolean) => void = () => {};
let rerender: () => void = () => {};
let setId: (v: number) => void = () => {};
let later: Array<() => void> = [];

const send = () => sent.push({ startedAt: Date.now(), commitSeq: currentCommitSeq() });

// 의존성 [] 인 effect 가 요청을 보내고, 다른 effect 는 매 렌더 새로 만드는 콜백을 의존성으로 받는다.
const AIChatbot = ({ onSelect, deferred }: { onSelect: () => void; deferred?: boolean }) => {
  useEffect(() => {
    // deferred: await 뒤에 보내는 요청(그 사이 다른 commit 이 낄 수 있다)
    if (deferred) later.push(send);
    else send();
  }, [deferred]);
  useEffect(() => {
    onSelect();
  }, [onSelect]);
  return null;
};

// 로딩 중에는 AIChatbot 대신 로딩 표시를 그려, false → true → false 로 바뀌면 AIChatbot 이 다시 마운트된다.
const Header = ({ deferred }: { deferred?: boolean }) => {
  const [loading, set] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    setLoading = set;
    rerender = () => setTick((n) => n + 1);
  }, []);
  return loading ? <span>loading</span> : <AIChatbot onSelect={() => undefined} deferred={deferred} />;
};

// 요청 effect 의 의존성이 실제로 바뀌는 경우. 뒤 effect 는 매 렌더 새로 만드는 콜백을 의존성으로 받는다.
const Profile = ({ id, onSelect }: { id: number; onSelect: () => void }) => {
  useEffect(() => {
    send();
    ids.push(id);
  }, [id]);
  useEffect(() => {
    onSelect();
  }, [onSelect]);
  return null;
};
const Page = () => {
  const [id, set] = useState(1);
  const [, setTick] = useState(0);
  useEffect(() => {
    setId = set;
    rerender = () => setTick((n) => n + 1);
  }, []);
  return <Profile id={id} onSelect={() => undefined} />;
};

// 다른 곳의 commit(요청과 무관한 컴포넌트)
let tickOther: () => void = () => {};
const Other = () => {
  const [, set] = useState(0);
  useEffect(() => {
    tickOther = () => set((n) => n + 1);
  }, []);
  return null;
};

/** time 에 fn 을 실행한다. flush 가 false 면 유휴 큐를 비우지 않는다(원인 판정 뒤에 렌더 기록이 쌓이는 순서). */
const at = (time: number, fn: () => void, flush = true) => {
  vi.setSystemTime(time);
  act(fn);
  if (flush) flushQueue();
};

const causeOf = (component: string, request: Sent, previous?: Sent) => {
  const record: RequestRecord = {
    id: 2,
    kind: 'fetch',
    method: 'GET',
    url: '/argus/v1/models',
    status: 200,
    durationMs: 1,
    body: undefined,
    duplicateOf: 1,
    component,
    ...request,
  };
  const step = repeatCauseStep(record, previous?.commitSeq);
  while (!step());
  return record.repeatCause;
};

describe('다시 마운트로 생긴 중복 요청의 원인 (#53)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    sent = [];
    ids = [];
    later = [];
    setRenderMonitoring(true);
    resetRenderStats();
  });
  afterEach(() => {
    cleanup();
    setRenderMonitoring(false);
    vi.useRealTimers();
  });

  it('다시 마운트된 뒤 다른 effect 의 함수 의존성이 바뀌어도 deps 가 아니라 remount 다', () => {
    at(1392, () => void render(<Header />));
    at(1416, () => setLoading(true));
    at(1458, () => setLoading(false));
    at(1500, () => rerender()); // 다시 마운트된 뒤 한 번 더 렌더(onSelect 가 바뀐다)
    expect(sent.map((s) => s.startedAt)).toEqual([1392, 1458]);
    expect(causeOf('AIChatbot', sent[1], sent[0])).toEqual({
      kind: 'remount',
      detail: '<AIChatbot> remount, parent <Header> branch changed',
    });
  });

  it('다시 마운트 직후(다음 렌더 전)에 찾아도 remount 다', () => {
    at(1392, () => void render(<Header />));
    at(1416, () => setLoading(true));
    at(1458, () => setLoading(false));
    expect(causeOf('AIChatbot', sent[1], sent[0])?.kind).toBe('remount');
  });

  it('요청 effect 의 의존성이 바뀌었으면 지금처럼 deps 다', () => {
    at(1000, () => void render(<Page />));
    at(2000, () => setId(2));
    expect(ids).toEqual([1, 2]);
    const cause = causeOf('Profile', sent[1], sent[0]);
    expect(cause?.kind).toBe('deps');
    expect(cause?.detail).toContain('1 → 2');
  });

  it('요청 뒤 같은 밀리초에 다시 렌더돼도 요청을 보낸 commit 의 의존성 변경을 쓴다', () => {
    at(1000, () => void render(<Page />));
    at(2000, () => setId(2));
    at(2000, () => rerender()); // 같은 시각의 다음 commit(onSelect 만 바뀐다)
    expect(causeOf('Profile', sent[1], sent[0])?.detail).toContain('1 → 2');
  });

  it('뒤 렌더의 기록이 원인 판정보다 늦게 큐에 쌓여도 결과가 같다', () => {
    at(1000, () => void render(<Page />));
    at(2000, () => setId(2));
    at(2100, () => rerender(), false); // 이 commit 의 기록은 아직 큐에 있다
    expect(causeOf('Profile', sent[1], sent[0])?.detail).toContain('1 → 2');
    flushQueue();
    expect(causeOf('Profile', sent[1], sent[0])?.detail).toContain('1 → 2');
  });

  it('await 뒤에 보내 그 사이 다른 컴포넌트의 commit 이 끼어도 remount 다', () => {
    at(
      1000,
      () =>
        void render(
          <>
            <Header deferred />
            <Other />
          </>,
        ),
    );
    later.splice(0).forEach((f) => f());
    at(1100, () => setLoading(true));
    at(1200, () => setLoading(false));
    at(1210, () => tickOther()); // 요청과 무관한 commit
    vi.setSystemTime(1220);
    later.splice(0).forEach((f) => f());
    expect(causeOf('AIChatbot', sent[1], sent[0])?.kind).toBe('remount');
  });
  it('await 뒤에 보내기 전에 다시 마운트되고 함수 의존성만 바뀐 렌더가 끼면, 어느 쪽인지 몰라 deps 를 붙이지 않는다', () => {
    at(
      1000,
      () =>
        void render(
          <>
            <Header deferred />
            <Other />
          </>,
        ),
    );
    later.splice(0).forEach((f) => f());
    at(1100, () => setLoading(true));
    at(1200, () => setLoading(false));
    at(1205, () => rerender()); // onSelect 만 바뀐 렌더
    at(1210, () => tickOther());
    vi.setSystemTime(1220);
    later.splice(0).forEach((f) => f());
    expect(causeOf('AIChatbot', sent[1], sent[0])).toBeUndefined();
  });
});
