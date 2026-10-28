import { isLibraryFrame } from './libraryFrame.js';

// 이름이 대문자로 시작해도 컴포넌트가 아닌 내장 객체 접두어
const NOT_COMPONENT =
  /^(Object|Promise|Array|Function|Window|Module|XMLHttpRequest|Generator|AsyncFunction|Reflect|Proxy|Timeout|HTML\w*Element|Document|EventTarget|WebSocket|MessagePort)$/;

/** 스택 한 줄의 함수 이름. V8 "at A.m (url:1:2)"·"at async A (…)", Firefox·Safari "A@url:1:2". 이름 없는 줄은 undefined. */
const functionOf = (line: string): string | undefined =>
  /^at (?:async )?(?:new )?([^\s(]+) \(/.exec(line)?.[1] ?? /^([^\s@]+)@/.exec(line)?.[1];

/**
 * 호출 스택에서 요청을 보낸 컴포넌트 이름. 라이브러리 프레임을 건너뛰고 처음 나오는 대문자 이름의 함수를 쓴다.
 * 클래스 메서드(`ItemCard.loadData`)는 클래스 이름이다. 못 찾으면 undefined.
 * shortcut: 대문자 이름 규칙으로 컴포넌트를 짐작한다. 대문자 클래스·팩토리(ApiClient.get)가 앱 프레임에 앞서면 틀릴 수 있다.
 */
export const componentOfStack = (stack: string | undefined): string | undefined =>
  stack
    ?.split('\n')
    .map((line) => line.trim())
    .filter((line) => !isLibraryFrame(line))
    .map((line) => functionOf(line)?.split(/[./]/)[0])
    .find((name): name is string => !!name && /^[A-Z]/.test(name) && !NOT_COMPONENT.test(name));

/** 스택에 앱 코드 프레임(위치가 있고 라이브러리·Node 내부가 아닌 줄)이 하나라도 있는지. ky 의 타이머 경로처럼 비동기 경계에서 끊기면 false. */
export const hasAppFrame = (stack: string | undefined): boolean =>
  !!stack?.split('\n').some((line) => /:\d+:\d+\)?$/.test(line.trim()) && !isLibraryFrame(line) && !/\bnode:/.test(line));
