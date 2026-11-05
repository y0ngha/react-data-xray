/**
 * 보고서 섹션·summary·compare 가 같은 대상을 가리키는 문자열 id. 숫자로 매기면 실행마다 달라져 두 보고서를 잇지 못하므로
 * 이름과 위치로 만든다. 엔드포인트는 `ep:GET /items/:id`, 컴포넌트는 `c:Name@src/a.tsx:12`(위치를 모르면 `c:Name`).
 */
export const endpointId = (endpoint: string): string => `ep:${endpoint}`;

export const componentId = (name: string, location?: string): string => (location ? `c:${name}@${location}` : `c:${name}`);
