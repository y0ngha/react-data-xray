# data-source-inspector

화면의 React 컴포넌트가 **어느 API 응답으로 그려지는지**, 요청이 낭비되거나 렌더가 반복되지 않는지 보여 주는 개발용 도구입니다. React Query Devtools처럼 컴포넌트 하나만 넣으면 됩니다.

- React 18 이상
- `fetch`, `XMLHttpRequest`를 가로채므로 React Query, SWR, axios, `useEffect` + `fetch`, redux 모두 대응
- production 빌드에서는 빈 컴포넌트가 되어 아무것도 하지 않습니다

## 사용법

```tsx
// 엔트리 파일의 앞쪽에서 import 합니다. 다른 모듈이 요청을 보내기 전에 fetch 를 감싸야 하고,
// 렌더 감시를 위해 react-dom 보다 먼저 평가돼야 합니다.
import { DataSourceDevtools } from 'data-source-inspector';

createRoot(root).render(
  <>
    <App />
    <DataSourceDevtools />
  </>,
);
```

오른쪽 아래의 `API` 버튼(드래그로 이동)을 누르면 패널이 열립니다.

| 기능 | 하는 일 |
|---|---|
| ⌖ 요소 선택 | 요소를 클릭하면 컴포넌트, 요청(URL, 쿼리, payload), 응답 안의 경로, queryKey를 보여 줍니다. 단축키 Ctrl/Cmd+Shift+D |
| ▦ 전체 표시 | 데이터 출처가 있는 요소마다 박스와 URL 라벨을 그립니다. 빨강은 낭비 요청에서 온 데이터입니다. |
| 요청 탭 | 엔드포인트별 호출 수, 중복 요청, 같은 응답 재요청, 평균 응답 시간 |
| 타임라인 탭 | 최근 20초의 요청, 렌더 commit, 요청 몰림 구간 |
| 렌더 탭 | 렌더가 잦은 컴포넌트와 그 컴포넌트가 쓰는 API |

매칭은 `[정확]`(같은 참조), `[파생]`(가공된 객체지만 필드 값이 일치), `[추정]`(화면 글자만 일치) 세 단계로 표시합니다.

## 문서

- [CONTEXT.md](./docs/CONTEXT.md): 목표, 방법과 그 이유, 한계
- [ROADMAP.md](./docs/ROADMAP.md): 앞으로 할 일
