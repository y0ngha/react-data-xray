# react-data-xray (rdx)

화면의 React 컴포넌트가 **어느 API 응답으로 그려지는지**, 요청이 낭비되거나 렌더가 반복되지 않는지 보여 주는 개발용 도구입니다. React Query Devtools처럼 컴포넌트 하나만 넣으면 됩니다.

- React 18 이상
- `fetch`, `XMLHttpRequest`를 가로채므로 React Query, SWR, axios, `useEffect` + `fetch`, redux 모두 대응
- production 빌드에서는 빈 컴포넌트가 되어 아무것도 하지 않습니다

## 요구 사항

- React 18 이상, 개발 빌드(dev 서버)에서 씁니다.
- **React DevTools 확장은 설치하지 않아도 됩니다.** rdx 는 렌더를 보기 위해 React DevTools 와 같은 전역 훅(`__REACT_DEVTOOLS_GLOBAL_HOOK__`)을 씁니다. 확장이 없으면 rdx 가 최소한의 훅을 직접 만들고, 확장이 있으면 그 훅에 함께 붙어 둘 다 그대로 동작합니다.
- 대신 **rdx 를 react-dom 보다 먼저 import 해야 합니다.** react-dom 은 로드될 때 이 훅에 자신을 등록하므로, 그 뒤에 rdx 를 불러오면 렌더 분석이 동작하지 않습니다(요청 가로채기도 다른 모듈이 요청을 보내기 전에 설치돼야 합니다). 엔트리 파일의 맨 앞쪽, 폴리필 바로 다음에 두세요.

## 사용법

```tsx
// 엔트리 파일의 앞쪽에서 import 합니다. 다른 모듈이 요청을 보내기 전에 fetch 를 감싸야 하고,
// 렌더 감시를 위해 react-dom 보다 먼저 평가돼야 합니다.
import { RdxDevtools } from 'react-data-xray';

createRoot(root).render(
  <>
    <App />
    <RdxDevtools />
  </>,
);
```

오른쪽 아래의 `RDX` 버튼(드래그로 이동)을 누르면 패널이 열립니다. 패널 오른쪽 위에서 표시 방식을 고릅니다: 작게 보기(▭), 하단 도킹(⬓), 오른쪽 도킹(◨), 별도 창(⧉). 도킹했을 때는 안쪽 가장자리를 끌어 크기를 바꿉니다.

rdx가 보여 주는 요청은 어디서든 클릭하면 **요청 상세**(Query, Request/Response Headers, Body)가 열립니다.

| 기능 | 하는 일 |
|---|---|
| ⌖ 요소 선택 | 요소를 클릭하면 컴포넌트, 요청(URL, 쿼리, payload), 응답 안의 경로, queryKey를 보여 줍니다. 단축키 Ctrl/Cmd+Shift+D |
| ▦ 전체 표시 | 데이터 출처가 있는 요소마다 박스와 URL 라벨을 그립니다. 빨강은 낭비 요청에서 온 데이터입니다. |
| 네트워크 › 요청 | 엔드포인트별 호출 수, 중복 요청, 같은 응답 재요청, 평균 응답 시간 |
| 네트워크 › 타임라인 | 최근 20초의 요청, 렌더 commit, 요청 몰림 구간 |
| 렌더 › 분석 | 렌더가 잦은 컴포넌트, 자기 렌더 시간, 렌더 이유(state, props, 같은 내용 새 참조, 부모/context)와 고치는 방법, 그 컴포넌트가 쓰는 API |

매칭은 `[정확]`(같은 참조), `[파생]`(가공된 객체지만 필드 값이 일치), `[추정]`(화면 글자만 일치) 세 단계로 표시합니다.

## 문서

- [CONTEXT.md](./docs/CONTEXT.md): 목표, 방법과 그 이유, 한계
- [ROADMAP.md](./docs/ROADMAP.md): 앞으로 할 일

## 개발

```bash
pnpm install
pnpm check          # 타입체크 → oxlint → react-doctor → oxfmt 검사 → 테스트·커버리지(80% 이상)
pnpm test           # 테스트만
pnpm fmt            # 포맷 적용
pnpm sync <앱 경로>  # 빌드해서 file: 로 연결한 앱의 node_modules 에 반영하고 Vite 캐시 파일을 지운다
```

- 테스트는 각 폴더의 `__tests__` 에 둡니다. 테스트 안에서 시나리오용 컴포넌트를 그 자리에서 정의하는 것은 의도된 패턴이라, 테스트 폴더에서만 `unicorn/consistent-function-scoping` 을 끕니다(`.oxlintrc.json`). 테스트 픽스처는 rdx 가 관찰할 `useEffect + fetch` 패턴을 일부러 재현하므로 react-doctor 의 `no-fetch-in-effect` 도 테스트 폴더에서만 끕니다(`react-doctor.config.json`).
- react-doctor 는 공급망 검사(의존성 목록을 외부로 보냄)와 사용 통계 전송을 끄고 실행합니다.
- 컴파일 대상은 ES2020 입니다. `toSorted`·`toReversed` 같은 ES2023 메서드는 폴리필 없이 오래된 브라우저에서 깨지므로 쓰지 않고, 이를 권하는 `unicorn/no-array-sort`·`no-array-reverse` 는 끕니다. 대신 복사한 배열에서만 `sort`·`reverse` 합니다.
