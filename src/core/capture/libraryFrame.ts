// 스택 한 줄이 라이브러리 코드인지. node_modules 경로이거나 Vite 사전 번들(.vite/deps) 이면 라이브러리다.
// webpack-internal:///./node_modules/... 도 node_modules 로 걸린다.
export const isLibraryFrame = (line: string): boolean => /node_modules|\.vite\/deps/.test(line);
