// 순서가 중요하다: 렌더 감시는 react-dom 보다 먼저 평가돼야 React 의 commit 을 받을 수 있다.
import { ignoreComponent } from './core/render/monitor.js';
import { installCapture } from './core/capture/install.js';
import { RdxDevtools as Devtools, type RdxDevtoolsProps } from './ui/RdxDevtools.js';

export type { RdxDevtoolsProps } from './ui/RdxDevtools.js';

// 조건을 변수에 담지 않고 직접 쓴다. 그래야 webpack 도 production 에서 dev 분기를 상수로 접어 패널 코드를 지운다.
if (process.env.NODE_ENV !== 'production') {
  // 컴포넌트 mount 보다 먼저 요청이 나가므로(자식 effect 가 먼저 돈다) import 시점에 설치한다.
  installCapture();
  // 패널 자신의 렌더는 렌더 감시에서 뺀다.
  ignoreComponent(Devtools);
}

/** production 빌드에서는 아무것도 그리지 않는 빈 컴포넌트로 바뀐다. */
export const RdxDevtools: (props: RdxDevtoolsProps) => ReturnType<typeof Devtools> | null =
  process.env.NODE_ENV !== 'production' ? Devtools : () => null;
