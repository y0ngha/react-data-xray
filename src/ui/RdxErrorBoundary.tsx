import { Component, type ReactNode } from 'react';

import { resetViewState } from './viewState.js';

/** rdx 가 깨져도 앱은 살아야 한다. rdx 아래에서 난 렌더 오류는 여기서 멈추고 rdx 만 숨긴다. */
export class RdxErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    // 기억한 화면 상태를 지워, 새로고침하면 rdx 가 처음 상태로 다시 뜨게 한다(같은 화면이 다시 열려 또 깨지지 않게).
    resetViewState();
    console.warn(
      '[react-data-xray] 오류가 나서 rdx 를 숨겼습니다. 앱은 계속 동작하고, 새로고침하면 rdx 가 처음 상태로 다시 뜹니다.',
      error,
    );
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
