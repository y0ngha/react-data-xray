import { useEffect } from 'react';

import { setRenderMonitoring } from '../../core/render/monitor.js';

/** 이 훅을 쓰는 컴포넌트가 화면에 있는 동안(enabled 인 동안) 렌더 감시를 켠다. */
export const useRenderMonitoring = (enabled = true): void => {
  useEffect(() => {
    if (!enabled) return undefined;
    setRenderMonitoring(true);
    return () => setRenderMonitoring(false);
  }, [enabled]);
};
