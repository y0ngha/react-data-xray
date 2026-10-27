import { useSyncExternalStore } from 'react';

import { RdxDevtools, type RdxDevtoolsProps } from './RdxDevtools.js';
import { RdxErrorBoundary } from './RdxErrorBoundary.js';

const subscribeNothing = () => () => undefined;
const onClient = () => true;
const onServer = () => false;

/**
 * 서버 렌더와 하이드레이션 중에는 false. rdx 화면은 window·저장소·DOM 을 바로 쓰므로 브라우저에서만 그린다.
 * (Next.js 처럼 앱을 서버에서 먼저 그리면, 그리지 않고 넘어가야 서버 렌더가 깨지지 않는다.)
 */
const useIsClient = (): boolean => useSyncExternalStore(subscribeNothing, onClient, onServer);

/** 앱에 붙는 바깥 컴포넌트. rdx 안의 렌더 오류가 앱의 React 루트까지 무너뜨리지 않게 감싼다. */
export const SafeRdxDevtools = (props: RdxDevtoolsProps) =>
  useIsClient() ? (
    <RdxErrorBoundary>
      <RdxDevtools {...props} />
    </RdxErrorBoundary>
  ) : null;
