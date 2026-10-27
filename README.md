# data-source-inspector

화면의 요소를 클릭하면, 그 컴포넌트가 보여 주는 데이터가 **어느 API 응답의 어느 필드에서 왔는지** 알려 주는 React 개발용 도구입니다. React Query Devtools처럼 컴포넌트 하나만 넣으면 됩니다.

- React 18 이상
- `fetch`, `XMLHttpRequest`(axios 포함), React Query, `useEffect` + `fetch`, redux 모두 대응
- production 빌드에서는 빈 컴포넌트가 되어 아무것도 하지 않습니다

## 사용법

```tsx
// 엔트리 파일의 첫 import 로 둡니다. 다른 모듈이 요청을 보내기 전에 fetch 를 감싸야 합니다.
import { DataSourceDevtools } from 'data-source-inspector';

createRoot(root).render(
  <>
    <App />
    <DataSourceDevtools />
  </>,
);
```

1. `Ctrl+Shift+D`(macOS는 `Cmd+Shift+D`)로 검사 모드를 켭니다.
2. 확인할 요소를 클릭합니다.
3. 패널에 컴포넌트 이름, 요청(메서드, URL, 상태, 시간), 응답 안의 경로, React Query라면 `queryKey`가 나옵니다.

단축키는 `<DataSourceDevtools hotkey={{ key: 'e', shift: true }} />`로 바꿀 수 있습니다.

## 동작 방식

1. `fetch`, `Response.json/text`, `XMLHttpRequest`, `JSON.parse`를 감싸서 응답 JSON 안의 모든 객체와 배열을 `WeakMap<객체, {요청, 경로}>`에 등록합니다.
2. 클릭한 DOM에서 React fiber를 찾아 위로 올라가며 props와 훅 state를 훑습니다. 등록된 객체가 **같은 참조로** 있으면 `[정확]`으로 표시합니다.
3. 참조로 찾지 못하면(가공해서 새 객체가 된 경우) 클릭한 요소의 글자와 같은 값을 최근 응답에서 찾아 `[추정]`으로 표시합니다.

## 한계

- `select`, `.map(i => ({...i}))`처럼 새 객체를 만들면 참조가 끊겨 추정으로만 찾습니다.
- context로만 내려받은 값은 아직 찾지 못합니다.
- React 내부 구조(fiber)를 읽으므로, React가 그 구조를 바꾸면 깨질 수 있습니다.
- 최근 응답 200건만 기억합니다.

## 로드맵

- React Query 캐시키 설계 감시: 같은 데이터를 다른 키로 중복 캐시하는지, 무효화(`invalidateQueries`)에 쓰는 키 접두사가 실제 쿼리와 맞는지, 키에 빠진 의존 값이 있는지
- context 값 추적
- 요청을 보낸 코드 위치(호출 스택) 표시
