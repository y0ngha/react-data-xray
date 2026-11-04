import { act, cleanup, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRenderStats, setRenderMonitoring } from '../../render/monitor.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { repeatCauseStep } from '../repeatCause.js';
import type { RequestRecord } from '../types.js';

// 요청을 보낸 시각. 실제 fetch 대신 effect 가 돈 시각을 적는다.
let sent: number[] = [];
let ids: number[] = [];
let setLoading: (v: boolean) => void = () => {};
let rerender: () => void = () => {};
let setId: (v: number) => void = () => {};

// 의존성 [] 인 effect 가 요청을 보내고, 다른 effect 는 매 렌더 새로 만드는 콜백을 의존성으로 받는다.
const AIChatbot = ({ onSelect }: { onSelect: () => void }) => {
  useEffect(() => {
    sent.push(Date.now());
  }, []);
  useEffect(() => {
    onSelect();
  }, [onSelect]);
  return null;
};

// 로딩 중에는 AIChatbot 대신 로딩 표시를 그려, false → true → false 로 바뀌면 AIChatbot 이 다시 마운트된다.
const Header = () => {
  const [loading, set] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    setLoading = set;
    rerender = () => setTick((n) => n + 1);
  }, []);
  return loading ? <span>loading</span> : <AIChatbot onSelect={() => undefined} />;
};

// 요청 effect 의 의존성이 실제로 바뀌는 경우. 뒤 effect 는 매 렌더 새로 만드는 콜백을 의존성으로 받는다.
const Profile = ({ id, onSelect }: { id: number; onSelect: () => void }) => {
  useEffect(() => {
    sent.push(Date.now());
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

const at = (time: number, fn: () => void) => {
  vi.setSystemTime(time);
  act(fn);
  flushQueue();
};

const causeOf = (component: string, startedAt: number) => {
  const record: RequestRecord = {
    id: 2,
    kind: 'fetch',
    method: 'GET',
    url: '/argus/v1/models',
    status: 200,
    startedAt,
    durationMs: 1,
    body: undefined,
    duplicateOf: 1,
    component,
  };
  const step = repeatCauseStep(record);
  while (!step());
  return record.repeatCause;
};

describe('다시 마운트로 생긴 중복 요청의 원인 (#53)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    sent = [];
    ids = [];
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
    expect(sent).toEqual([1392, 1458]);
    expect(causeOf('AIChatbot', 1458)).toEqual({ kind: 'remount', detail: '<AIChatbot> remount, parent <Header> branch changed' });
  });

  it('다시 마운트 직후(다음 렌더 전)에 찾아도 remount 다', () => {
    at(1392, () => void render(<Header />));
    at(1416, () => setLoading(true));
    at(1458, () => setLoading(false));
    expect(causeOf('AIChatbot', 1458)?.kind).toBe('remount');
  });

  it('요청 effect 의 의존성이 바뀌었으면 지금처럼 deps 다', () => {
    at(1000, () => void render(<Page />));
    at(2000, () => setId(2));
    expect(sent).toEqual([1000, 2000]);
    expect(ids).toEqual([1, 2]);
    const cause = causeOf('Profile', 2000);
    expect(cause?.kind).toBe('deps');
    expect(cause?.detail).toContain('1 → 2');
  });

  it('요청 뒤에 다시 렌더돼 요청을 보낸 렌더를 알 수 없으면 틀린 값 대신 비워 둔다', () => {
    at(1000, () => void render(<Page />));
    at(2000, () => setId(2));
    at(2100, () => rerender());
    expect(causeOf('Profile', 2000)).toBeUndefined();
  });
});
