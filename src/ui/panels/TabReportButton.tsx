import { useRef } from 'react';

import { getTabId, tabReportPath } from '../../core/report/reportApi.js';
import { useFlash } from '../hooks/useFlash.js';
import { Button } from '../components/Button.js';
import { color } from '../theme.js';

const FLASH_MS = 4000;

/** 이 탭의 보고서 경로를 복사한다. 사람이 AI 에게 "이 탭을 봐" 라고 가리킬 때 쓴다. */
export const TabReportButton = () => {
  const id = getTabId();
  const path = tabReportPath();
  const holder = useRef<HTMLSpanElement>(null);
  const [flash, setFlash] = useFlash(FLASH_MS);

  const copy = async () => {
    // 별도 창에 도킹했다면 클릭한 창(ownerDocument)의 clipboard 를 써야 사용자 동작으로 인정된다.
    const clipboard = (holder.current?.ownerDocument.defaultView ?? window).navigator.clipboard;
    try {
      await clipboard.writeText(path);
      setFlash('Copied');
    } catch {
      setFlash(`Copy failed: ${path}`, true);
    }
  };

  return (
    <span ref={holder}>
      <Button onClick={() => void copy()} title={`Copy report path for tab ${id}: ${path}`}>
        Copy report path
      </Button>
      {flash && <output style={{ color: color.muted, marginLeft: 4 }}>{flash}</output>}
    </span>
  );
};
