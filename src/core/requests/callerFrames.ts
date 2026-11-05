// 첫 줄은 대개 앱의 공통 fetch 함수라 그것만으로는 어디서 보냈는지 모른다. 바깥으로 몇 줄 더 본다.
const CALLER_FRAMES = 3;

/** 호출 스택의 앞쪽 몇 줄(rdx 프레임은 기록할 때 이미 뺐다). 보고서 callers 와 N+1 판정(보낸 컴포넌트를 모를 때)이 같이 쓴다. */
export const callerOf = (stack: string | undefined): string | undefined =>
  stack
    ?.split('\n')
    .map((line) => line.trim())
    // V8: "at fn (url:1:2)", Firefox·Safari: "fn@url:1:2"
    .filter((line) => line.startsWith('at ') || /@.+:\d+:\d+$/.test(line))
    .slice(0, CALLER_FRAMES)
    // dev 서버가 파일을 고칠 때마다 붙이는 ?t=·?v= 를 뗀다. 그래야 같은 호출 위치가 고칠 때마다 갈라지지 않는다.
    .map((line) => line.replace(/\?[^\s:)]*(?=:\d+:\d+)/g, ''))
    .join(' <- ') || undefined;
