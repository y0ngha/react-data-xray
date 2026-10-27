import { RdxDevtools, type RdxDevtoolsProps } from './RdxDevtools.js';
import { RdxErrorBoundary } from './RdxErrorBoundary.js';

/** 앱에 붙는 바깥 컴포넌트. rdx 안의 렌더 오류가 앱의 React 루트까지 무너뜨리지 않게 감싼다. */
export const SafeRdxDevtools = (props: RdxDevtoolsProps) => (
  <RdxErrorBoundary>
    <RdxDevtools {...props} />
  </RdxErrorBoundary>
);
