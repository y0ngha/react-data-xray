// 순서가 중요하다: renderMonitor 는 react-dom 보다 먼저 평가돼야 렌더 훅을 잡을 수 있다.
import './renderMonitor.js';
import { install } from './capture.js';
import { DataSourceDevtools as Devtools, type DataSourceDevtoolsProps } from './Devtools.js';

export type { DataSourceDevtoolsProps } from './Devtools.js';

const isDev = process.env.NODE_ENV !== 'production';

// 컴포넌트 mount 보다 먼저 요청이 나가므로(자식 effect 가 먼저 돈다) import 시점에 설치한다.
if (isDev) install();

/** production 빌드에서는 아무것도 그리지 않는 빈 컴포넌트로 바뀐다. */
export const DataSourceDevtools: (props: DataSourceDevtoolsProps) => ReturnType<typeof Devtools> | null = isDev
  ? Devtools
  : () => null;
