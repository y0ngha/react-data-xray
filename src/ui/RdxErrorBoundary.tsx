import { Component, type ReactNode } from 'react';

/** rdx 가 깨져도 앱은 살아야 한다. rdx 아래에서 난 렌더 오류는 여기서 멈추고 rdx 만 숨긴다. */
export class RdxErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.warn('[react-data-xray] 오류가 나서 패널을 닫았습니다. 앱은 계속 동작합니다.', error);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
