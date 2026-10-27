/**
 * 브라우저 저장소를 안전하게 쓴다. 시크릿 모드·저장소 차단·잘못된 값이어도 앱을 깨지 않고 기본값을 돌려준다.
 * 저장은 편의 기능이라 실패해도 조용히 넘어간다.
 * - local: 사용자 취향(도킹 방식, 버튼 위치, 무시 목록). 새 탭에서도 이어진다.
 * - session: 지금 보고 있는 화면 상태와 요청 기록. 새로고침해도 남고 탭을 닫으면 사라진다.
 */
export type StorageArea = 'local' | 'session';

const storageOf = (area: StorageArea): Storage => (area === 'session' ? sessionStorage : localStorage);

export const readStored = <T>(key: string, parse: (raw: unknown) => T | undefined, fallback: T, area: StorageArea = 'local'): T => {
  try {
    const raw = storageOf(area).getItem(key);
    if (raw === null) return fallback;
    return parse(JSON.parse(raw)) ?? fallback;
  } catch {
    return fallback;
  }
};

export const writeStored = (key: string, value: unknown, area: StorageArea = 'local'): void => {
  try {
    storageOf(area).setItem(key, JSON.stringify(value));
  } catch {
    // 저장소를 못 쓰는 환경이거나 용량이 넘치면 넘어간다.
  }
};
