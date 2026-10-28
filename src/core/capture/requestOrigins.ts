import { attempt } from './attempt.js';
import { captureStack } from './requestContext.js';

// ky 는 앱이 ky.get() 을 부르는 동기 시점에 Request 를 만들고, 나중에 타이머 안에서 그것(또는 clone)을 fetch 에 넘긴다.
// 그래서 생성 시점의 스택(Error, .stack 은 늦게 읽는다)을 Request 에 붙여 두고 fetch 가로채기가 앱 프레임을 찾지 못할 때 쓴다.
const createdAt = new WeakMap<object, Error>();

const WRAPPED = Symbol.for('react-data-xray:request-origins');

/** 이 Request 를 만든 시점의 스택 */
export const requestOrigin = (input: unknown): Error | undefined => (typeof input === 'object' && input ? createdAt.get(input) : undefined);

/** 전역 Request 생성자와 clone 을 감싼다. instanceof·prototype 은 그대로다(Proxy). */
export const interceptRequestOrigins = (): void => {
  if ((globalThis.Request as unknown as Record<symbol, boolean>)[WRAPPED]) return; // HMR·재설치로 겹쳐 감싸지 않는다
  const OriginalRequest = globalThis.Request;
  const originalClone = OriginalRequest.prototype.clone;
  globalThis.Request = new Proxy(OriginalRequest, {
    get: (target, key, receiver) => (key === WRAPPED ? true : Reflect.get(target, key, receiver)),
    construct(target, args, newTarget) {
      const request = Reflect.construct(target, args, newTarget) as Request;
      attempt(() => createdAt.set(request, captureStack()));
      return request;
    },
  });
  OriginalRequest.prototype.clone = function () {
    const cloned = originalClone.call(this);
    attempt(() => {
      const origin = createdAt.get(this);
      if (origin) createdAt.set(cloned, origin);
    });
    return cloned;
  };
};
