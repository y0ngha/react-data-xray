/**
 * 보고서 섹션·summary·compare 가 같은 대상을 가리키는 문자열 id. 숫자로 매기면 실행마다 달라져 두 보고서를 잇지 못하므로
 * 이름과 위치로 만든다. 엔드포인트는 `ep:GET /items/:id`, 컴포넌트는 `c:Name@src/a.tsx:12`(위치를 모르면 `c:Name`).
 */
export const endpointId = (endpoint: string): string => `ep:${endpoint}`;

export const componentId = (name: string, location?: string): string => (location ? `c:${name}@${location}` : `c:${name}`);

/** 렌더 행을 가르는 값(render/groups 의 renderGroupKey 와 같은 값) */
export interface ComponentSiteKey {
  name: string;
  location?: string;
  package?: string;
  owner?: { name: string; location?: string };
}

/**
 * 렌더 행(renders.components[])의 id. 렌더 그룹 키와 같은 값으로 가른다: 앱 컴포넌트는 이름 + 그리는 위치,
 * 라이브러리 컴포넌트는 이름 + 패키지 + 그린 앱 컴포넌트(`c:Cell(ag-grid)<Grid@src/Grid.tsx:9`, 그린 앱 컴포넌트를 모르면 `c:Cell(ag-grid)`).
 * causedBy·startedBy·compare 도 이 함수로 만들어 같은 행과 맞는다.
 */
export const componentIdOf = (c: ComponentSiteKey): string =>
  c.package
    ? `c:${c.name}(${c.package})${c.owner ? `<${componentId(c.owner.name, c.owner.location).slice(2)}` : ''}`
    : componentId(c.name, c.location);
