---
name: rdx-perf
description: react-data-xray(rdx)로 React 화면의 낭비 요청과 불필요한 렌더를 재고, 원인을 코드에서 확인해 고친 뒤 다시 재서 전후를 비교한다. "이 화면 느려", "요청이 너무 많이 나가", "렌더가 너무 잦아", "rdx 보고서 보고 고쳐 줘", "성능 점검" 같은 요청에 쓴다. 앱에 rdx 가 붙어 있어야 한다.
---

# rdx 로 화면 성능 고치기

AI 로 빠르게 만든 화면은 실제 렌더·요청 비용을 확인하지 않은 채 넘어가기 쉽다. 이 스킬은 rdx 가 모은 근거로
**측정 → 원인 확인 → 수정 → 다시 측정** 을 한 바퀴 돈다. rdx 출력은 출발점일 뿐이다. 코드에서 확인한 것만 고친다.

## 1. 준비 확인

1. 앱 진입 파일에 `import { RdxDevtools } from 'react-data-xray'` 와 `<RdxDevtools />` 가 있는지 본다. react-dom 보다 먼저 import 해야 한다.
2. dev 서버에 보고서 플러그인이 붙어 있는지 본다.
   - Vite: `vite.config` 의 `plugins` 에 `rdx()`(`import { rdx } from 'react-data-xray/vite'`)
   - webpack: `devServer.setupMiddlewares` 에서 `rdxReportMiddleware()`(`react-data-xray/middleware`)
3. 없으면 붙이는 방법을 사용자에게 알려 주고 멈춘다. 사용자의 빌드 설정은 허락 없이 고치지 않는다.
4. 보고서를 읽는 길은 둘이다.
   - 파일: 플러그인이 5초마다 `.rdx/report.json` 에 쓴다(dev 명령을 실행한 폴더 기준).
   - 브라우저 도구가 있으면: `window.__RDX__.report()`

## 2. 측정

시나리오마다 처음 상태에서 시작한다. 브라우저 도구가 있으면 직접, 없으면 사용자에게 한 줄씩 요청한다.

1. 고칠 화면을 연다.
2. `window.__RDX__.reset()` 으로 기록을 비운다(브라우저 도구가 없으면 새로고침 대신 이 단계를 생략하고 기록을 그대로 쓴다).
3. 시나리오를 실행한다.
   - 가만히 둔 30초: 폴링·주기 요청, 화면이 혼자 렌더되는지
   - 문제가 된 조작: 필터 변경, 탭 이동, 스크롤 등
4. `window.__RDX__.snapshot('before-<시나리오>')` 로 저장한다. `.rdx/before-<시나리오>.json` 이 생긴다.
   브라우저 도구가 없으면 `.rdx/report.json` 을 그 이름으로 복사해 둔다.
5. `renders.monitoring` 이 false 면 렌더 정보가 비어 있다. 한 번 더 측정한다.

## 3. 결과 읽기

`howToRead` 필드에도 같은 설명이 들어 있다.

### 요청 (`requests.endpoints`, 낭비 많은 순)

| 필드 | 뜻 |
|---|---|
| `duplicates` | 2초 안에 같은 요청(메서드·URL·쿼리·본문)이 또 나감 |
| `sameResponses` | 같은 요청의 직전 응답과 본문이 똑같음 |
| `review` | 주기 요청·포커스 재요청. 의도일 수 있지만 점검할 반복 |
| `ignored: true` | 사용자가 의도된 반복으로 지정함. 고치지 않는다 |
| `callers` | 요청을 보낸 코드(호출 스택 앞 3줄, 소스맵으로 원본 위치). 같은 엔드포인트를 여러 화면이 부르면 위치별로 나뉜다 |
| `restoredCount` | 그중 새로고침 전 페이지의 요청 수 |

### React Query (`reactQuery.findings`)

`duplicate-cache`(같은 요청을 다른 키로 캐시), `key-missing-param`(같은 키로 다른 요청), `invalidate-miss`(맞는 쿼리가 없던 무효화),
`stale-zero`(staleTime 0 이라 같은 응답 재요청). 각 항목의 `fix` 를 따른다.

### 렌더 (`renders.components`, 줄일 수 있는 렌더 많은 순)

| 필드 | 뜻 |
|---|---|
| `avoidable` | 줄일 수 있는 렌더(같은 내용 새 참조, 새 콜백, memo 아닌 컴포넌트의 부모 따라 렌더) |
| `causedBy` | 그 렌더를 시작한 조상과 이유(state·context·mount). **고칠 곳은 대개 이 조상이다** |
| `renderedAt` | 이 컴포넌트를 그리는 JSX 위치 |
| `networkCauses[].viaParent` | 조상이 응답으로 렌더돼서 따라 렌더된 횟수 |
| `networkCauses[].fromSameResponse` | 직전과 똑같은 응답인데도 렌더된 횟수 |
| `changedProps` | 같은 내용인데 새 참조로 온 props, 렌더마다 새로 만든 콜백, 바뀐 context |
| `advice` | rdx 가 제안하는 고치는 방법 |

## 4. 원인 확인(고치기 전에 반드시)

- `callers` 의 함수 이름과 `causedBy`·`renderedAt` 으로 코드를 연다. 줄 번호가 http 주소로 남은 줄은 소스맵이 없는 것이라 줄이 어긋날 수 있으니 함수 이름으로 찾는다.
- 진단이 코드와 맞는지 확인한다. 예: "화면 밖 카드도 폴링한다"는 진단은 LazyLoad 가 화면 밖 카드를 언마운트한다면 틀린 것이다.
- 확신이 없으면 고치지 말고 사용자에게 근거와 함께 묻는다.

## 5. 처방

| 진단 | 처방 |
|---|---|
| 중복 요청(같은 화면에서 두 컴포넌트가 같은 요청) | 공통 조상에서 한 번 받기, React Query 로 옮겨 캐시 공유 |
| 같은 응답 재요청 + 그 응답으로 렌더(`fromSameResponse`) | 같은 응답이면 setState 를 건너뛰기, React Query 의 structural sharing, `staleTime` 늘리기 |
| 주기 요청이 숨은 탭·화면 밖에서도 돎 | `document.hidden`·화면 표시 여부로 폴링 멈춤(`refetchInterval` 조건) |
| 부모를 따라 렌더(`causedBy` 가 조상) | 원인 조상의 불필요한 setState 를 먼저 고치고, 그다음 `React.memo` |
| 같은 내용 새 참조(`changedProps.sameContent`) | 부모에서 `useMemo`, 응답을 구조적 공유로 받기 |
| 새 콜백(`changedProps.newCallback`) | 부모에서 `useCallback` |
| context 변경 | 자주 바뀌는 값과 아닌 값의 context 분리, Provider value 를 `useMemo` |
| React Query 키 문제 | `reactQuery.findings[].fix` |

## 6. 지킬 것

- 동작을 바꾸지 않는다. 예: `setSummary({ ...data, before: summary })` 처럼 이전 값을 쓰는 화면은 같은 응답일 때 setState 를 건너뛰면 증감 표시가 달라질 수 있다. 그 값을 쓰는 곳을 먼저 확인한다.
- 한 번에 한 원인만 고치고 다시 잰다. 여러 개를 한꺼번에 고치면 무엇이 효과였는지 모른다.
- 대상 저장소의 테스트·린트 규칙(AGENTS.md, CLAUDE.md 등)을 따른다.

## 7. 다시 측정하고 보고

1. 같은 시나리오를 2번과 같은 순서로 다시 실행하고 `snapshot('after-<시나리오>')` 로 저장한다.
2. before/after 를 비교한다: 엔드포인트별 `count`·`duplicates`·`sameResponses`, 컴포넌트별 `renders`·`avoidable`.
3. 나아지지 않았으면 그 수정은 되돌린다.
4. 사용자에게 표로 보고한다: 무엇을 왜 고쳤는지(코드 위치), 전후 수치, 확인하지 못한 것.

## 참고

- 렌더 정보는 dev 빌드에서만 정확하다(React 18 의 `_debugSource` 가 있어야 `renderedAt` 이 나온다).
- `.rdx/` 는 rdx 가 `.gitignore` 를 만들어 저장소에 올라가지 않는다.
- 보고서에는 응답 본문과 헤더가 들어가지 않는다. URL 쿼리는 들어간다.
