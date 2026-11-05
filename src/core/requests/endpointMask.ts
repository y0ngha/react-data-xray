// 엔드포인트 이름의 ID 묶기. requestKey 와 설정(configure 의 무시 목록)이 같이 쓴다(설정이 requestKey 를 읽으면 순환이 된다).

const ID_SEGMENT_PATTERNS = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{16,}$/i,
  // 'usr_8f3a9c2d' 처럼 구분자가 있는 접두사형은 8자부터, 'grp0a1b…' 처럼 붙은 접두사형은 24자부터 ID 로 본다.
  /^[a-z]+[_-](?=[0-9a-f]*\d)[0-9a-f]{8,}$/i,
  /^[a-z]+[0-9a-f]{24,}$/i,
];

/** 경로 조각이 숫자·UUID·긴 16진수·접두사형 ID 면 ':id' 로 바꾼다. 'v2'·'members' 같은 조각은 그대로 둔다. */
export const maskIds = (path: string): string =>
  path
    .split('/')
    .map((segment) => (ID_SEGMENT_PATTERNS.some((re) => re.test(segment)) ? ':id' : segment))
    .join('/');

/** ID 묶기가 생기기 전에 저장한 엔드포인트("GET /items/5")를 지금 형식("GET /items/:id")으로 바꾼다. 이미 묶인 것은 그대로다. */
export const maskEndpoint = (endpoint: string): string =>
  endpoint.replace(/^(\S+ )(\S+)/, (_, method: string, path: string) => method + maskIds(path));
