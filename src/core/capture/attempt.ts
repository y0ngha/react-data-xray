/** rdx 의 기록 일을 한다. 실패해도 앱의 요청·파싱은 원래대로 끝나야 하므로 오류를 삼킨다. */
export const attempt = <T>(work: () => T): T | undefined => {
  try {
    return work();
  } catch {
    return undefined;
  }
};
