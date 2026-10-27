import { CLASS_COMPONENT, type Fiber, type Hook } from './types.js';

export interface ComponentValue {
  /** 컴포넌트 안에서 값이 있는 곳. 예: props, hook[2], useQuery */
  via: string;
  value: unknown;
  /** React Query 의 useQuery 결과면 그 queryKey */
  queryKey?: unknown;
}

interface QueryObserverLike {
  getCurrentResult: () => { data?: unknown };
  options: { queryKey: unknown };
}

/** react-query 의 QueryObserver 인지 모양으로 판단한다(패키지에 의존하지 않기 위해). */
const asQueryObserver = (value: unknown): QueryObserverLike | null => {
  const v = value as Partial<QueryObserverLike> | null;
  return v && typeof v.getCurrentResult === 'function' && v.options?.queryKey ? (v as QueryObserverLike) : null;
};

const hooksOf = (fiber: Fiber): Hook[] => {
  const hooks: Hook[] = [];
  for (let hook = fiber.memoizedState as Hook | null; hook && typeof hook === 'object' && 'next' in hook; hook = hook.next)
    hooks.push(hook);
  return hooks;
};

const hookValue = (hook: Hook, index: number): ComponentValue => {
  const observer = asQueryObserver(hook.memoizedState);
  return observer
    ? { via: 'useQuery', value: observer.getCurrentResult().data, queryKey: observer.options.queryKey }
    : { via: `hook[${index}]`, value: hook.memoizedState };
};

/** 컴포넌트가 들고 있는 값들: props, 훅 state(함수형), state(클래스형) */
export const collectValues = (fiber: Fiber): ComponentValue[] => [
  { via: 'props', value: fiber.memoizedProps },
  ...(fiber.tag === CLASS_COMPONENT ? [{ via: 'state', value: fiber.memoizedState }] : hooksOf(fiber).map(hookValue)),
];
