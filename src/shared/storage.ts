/**
 * localStorage 를 안전하게 쓴다. 시크릿 모드·저장소 차단·잘못된 값이어도 앱을 깨지 않고 기본값을 돌려준다.
 * 저장은 편의 기능이라 실패해도 조용히 넘어간다.
 */
export const readStored = <T>(key: string, parse: (raw: unknown) => T | undefined, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return parse(JSON.parse(raw)) ?? fallback;
  } catch {
    return fallback;
  }
};

export const writeStored = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 저장소를 못 쓰는 환경이면 넘어간다.
  }
};
