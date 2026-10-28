import { getTabId, tabReportPath } from '../../core/report/reportApi.js';
import { Button } from '../components/Button.js';

/** 이 탭의 id 와 보고서 경로를 보이고, 경로를 복사한다. 사람이 AI 에게 "이 탭을 봐" 라고 가리킬 때 쓴다. */
export const TabReportButton = () => {
  const id = getTabId();
  const path = tabReportPath();
  return (
    <Button onClick={() => void navigator.clipboard?.writeText(path).catch(() => undefined)} title={`이 탭 보고서 경로 복사: ${path}`}>
      탭 {id}
    </Button>
  );
};
