import { isLibraryFrame } from '../capture/libraryFrame.js';

// 첫 줄은 대개 앱의 공통 fetch 함수라 그것만으로는 어디서 보냈는지 모른다. 바깥으로 몇 줄 더 본다.
const CALLER_FRAMES = 3;

// V8: "at fn (url:1:2)", Firefox·Safari: "fn@url:1:2"
const isFrame = (line: string): boolean => line.startsWith('at ') || /@.+:\d+:\d+$/.test(line);
// dev 서버가 파일을 고칠 때마다 붙이는 ?t=·?v= 를 뗀다. 그래야 같은 호출 위치가 고칠 때마다 갈라지지 않는다.
const withoutDevQuery = (line: string): string => line.replace(/\?[^\s:)]*(?=:\d+:\d+)/g, '');

/**
 * 스택에서 앱 코드 프레임(라이브러리가 아닌 줄) 앞쪽 몇 줄만 줄바꿈으로 이어 남긴다. 앱 프레임이 없으면 앞쪽 프레임을 그대로 남긴다.
 * React Query finding 처럼 error.stack 원문을 받는 곳이 보고서에 짧게 싣고, 같은 호출 위치를 같은 문자열로 묶으려고 쓴다.
 */
export const appFramesOf = (stack: string | undefined, max = CALLER_FRAMES): string | undefined => {
  const frames = (stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(isFrame);
  const app = frames.filter((line) => !isLibraryFrame(line));
  return (app.length > 0 ? app : frames).slice(0, max).map(withoutDevQuery).join('\n') || undefined;
};

/** 호출 스택의 앞쪽 몇 줄(rdx 프레임은 기록할 때 이미 뺐다). 보고서 callers 와 N+1 판정(보낸 컴포넌트를 모를 때)이 같이 쓴다. */
export const callerOf = (stack: string | undefined): string | undefined =>
  stack
    ?.split('\n')
    .map((line) => line.trim())
    .filter(isFrame)
    .slice(0, CALLER_FRAMES)
    .map(withoutDevQuery)
    .join(' <- ') || undefined;
