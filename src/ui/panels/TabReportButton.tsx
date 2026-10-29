import { useEffect, useRef, useState } from 'react';

import { getTabId, tabReportPath } from '../../core/report/reportApi.js';
import { Button } from '../components/Button.js';
import { color } from '../theme.js';

const NOTICE_MS = 2500;

/** 이 탭의 id 와 보고서 경로를 보이고, 경로를 복사한다. 사람이 AI 에게 "이 탭을 봐" 라고 가리킬 때 쓴다. */
export const TabReportButton = () => {
  const id = getTabId();
  const path = tabReportPath();
  const holder = useRef<HTMLSpanElement>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const copy = async () => {
    // 별도 창에 도킹했다면 클릭한 창(ownerDocument)의 clipboard 를 써야 사용자 동작으로 인정된다.
    const clipboard = (holder.current?.ownerDocument.defaultView ?? window).navigator.clipboard;
    try {
      await clipboard.writeText(path);
      setNotice('Copied');
    } catch {
      setNotice(`Copy failed: ${path}`);
    }
  };
  return (
    <span ref={holder}>
      <Button onClick={() => void copy()} title={`Copy report path for this tab: ${path}`}>
        Tab {id}
      </Button>
      {notice && <output style={{ color: color.muted, marginLeft: 4 }}>{notice}</output>}
    </span>
  );
};
