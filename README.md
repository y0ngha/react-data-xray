# react-data-xray (rdx)

화면의 React 컴포넌트가 **어느 API 응답으로 그려지는지**, 그리고 그 과정에서 **요청이 낭비되거나 렌더가 쓸데없이 반복되지 않는지** 보여 주는 개발용 도구입니다. React Query Devtools 처럼 컴포넌트 하나만 넣으면 됩니다.

- "이 숫자는 어느 API 의 어느 필드에서 왔지?" → 요소를 클릭하면 요청 URL·payload·응답 경로(`$.data.summary.total`)·queryKey 를 보여 줍니다.
- "같은 요청이 왜 두 번 나가지?" → 엔드포인트별 중복 요청, 같은 응답 재요청, 요청 몰림을 셉니다.
- "이 컴포넌트는 왜 이렇게 자주 렌더되지?" → 렌더 이유, 렌더를 시작한 조상, 그 렌더를 일으킨 응답을 보여 줍니다.
- "AI 에게 고치라고 하고 싶다" → 같은 결과를 AI 가 읽는 보고서(`.rdx/report.json`)로 내보내고, 바로 쓸 수 있는 AI 스킬도 함께 줍니다.

`fetch`·`XMLHttpRequest` 를 가로채므로 React Query, SWR, axios, `useEffect` + `fetch`, redux 어느 쪽이든 동작합니다. production 빌드에서는 빈 컴포넌트가 되어 아무것도 하지 않습니다.

## 목차

- [시작하기](#시작하기)
- [화면 보는 법](#화면-보는-법)
- [AI 에게 결과 넘기기](#ai-에게-결과-넘기기)
- [AI 스킬: rdx-perf](#ai-스킬-rdx-perf)
- [알아 둘 것](#알아-둘-것)
- [개발](#개발)

## 시작하기

### 1. 설치

```bash
pnpm add -D react-data-xray
```

React 18 이상, dev 서버(개발 빌드)에서 씁니다. React DevTools 확장은 없어도 됩니다.

### 2. 엔트리 파일에 넣기

```tsx
// main.tsx: 폴리필 바로 다음, react-dom 과 앱 코드보다 먼저 import 합니다.
import { RdxDevtools } from 'react-data-xray';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <RdxDevtools />
  </>,
);
```

**import 순서가 중요합니다.** rdx 는 import 되는 순간 `fetch`·XHR 을 감싸고 React DevTools 전역 훅에 붙습니다. 앱 모듈이 먼저 요청을 보내거나 react-dom 이 먼저 로드되면 그 부분은 보지 못합니다. React DevTools 확장이 있으면 그 훅에 함께 붙어 둘 다 그대로 동작합니다.

요소 선택 단축키(기본 Ctrl/Cmd+Shift+D)는 `hotkey` 로 바꿀 수 있습니다.

```tsx
<RdxDevtools hotkey={{ key: 'x', shift: true }} />
```

### 3. (선택) 보고서 플러그인

AI 가 결과를 파일로 읽게 하려면 dev 서버에 플러그인을 붙입니다. 화면만 볼 거라면 필요 없습니다. 자세한 내용은 [AI 에게 결과 넘기기](#ai-에게-결과-넘기기)를 보세요.

```ts
// vite.config.ts
import { rdx } from 'react-data-xray/vite';

export default defineConfig({ plugins: [react(), rdx()] });
```

## 화면 보는 법

오른쪽 아래 `RDX` 버튼을 누르면 패널이 열립니다. 버튼은 끌어서 옮길 수 있고 위치를 기억합니다.

### 버튼 배지

버튼에는 **지금 문제 수**(낭비 요청이 있는 엔드포인트 + 렌더 폭주 중인 컴포넌트)가 붙습니다. 새 요청 몰림이나 새 렌더 폭주가 생기면 잠깐 색이 바뀝니다. 페이지 첫 로딩 때의 몰림, 무시하기로 한 요청, StrictMode 의 두 번 호출은 세지 않습니다. 패널을 닫아 두고 개발하다가 배지가 늘면 열어 보면 됩니다.

### 대상과 관점

툴바는 두 묶음입니다. **대상**은 무엇을 볼지, **관점**은 그 대상의 무엇을 볼지입니다. 대상을 하나 고르고 관점만 바꿔 가며 같은 화면을 데이터·네트워크·렌더 쪽에서 봅니다.

| 대상 | 하는 일 |
|---|---|
| ▦ 화면 전체 | 화면 전체를 봅니다(기본). |
| ⌖ 요소 선택 | 화면에서 요소를 클릭하면(Ctrl/Cmd+Shift+D), 그 요소에서 데이터를 가진 가장 가까운 컴포넌트가 대상이 됩니다. 툴바에 `<컴포넌트> 안 ✕` 가 붙고, ✕ 를 누르거나 컴포넌트가 사라지면 화면 전체로 돌아갑니다. |
| ☐ 박스 | 대상 안에서 응답 데이터를 쓰는 컴포넌트마다 박스와 라벨을 그립니다. |

| 관점 | 보여 주는 것 |
|---|---|
| 데이터 | 클릭한 요소의 출처(요청, 쿼리, payload, 응답 경로, queryKey, 값). 대상 안에서 API 별로 데이터를 쓰는 컴포넌트 |
| 네트워크 요청 | 엔드포인트별 호출 수·중복·같은 응답 재요청·평균 응답 시간, 전체 기록, React Query 캐시키 점검 |
| 네트워크 타임라인 | 최근 20초의 요청 막대, 렌더 commit, 요청 몰림 구간, 실패 요청 |
| 렌더 | 최근 10초에 자주 렌더된 컴포넌트, 렌더 이유별 횟수와 고치는 방법, 렌더를 시작한 조상, 그리는 JSX 위치, 그 렌더를 일으킨 응답 |

대상이 있으면 관점마다 그 안만 봅니다. 예를 들어 카드 하나를 고르고 "네트워크 요청" 으로 바꾸면 그 카드가 쓰는 요청만 남습니다.

rdx 가 보여 주는 요청은 어디서든 클릭하면 **요청 상세**가 열립니다: Query, Request/Response Headers, Body(정렬·복사), 요청을 보낸 코드(소스맵으로 원본 위치), 이 요청의 데이터를 쓰는 컴포넌트(호버하면 화면에서 강조).

### 박스 라벨 읽기

```
GET /api/projects  ×6 · 중복 2 · 같은 응답 3   ↻12(불필요 9)
```

- `×6`: 이 요청이 6번 나갔습니다. `중복 2` 는 2초 안에 같은 요청이 또 나간 수, `같은 응답 3` 은 직전과 본문이 똑같았던 수입니다.
- `↻12(불필요 9)`: 이 컴포넌트가 최근 10초에 12번 렌더됐고 그중 9번은 줄일 수 있었습니다.
- 색: 초록은 정확(응답 객체를 그대로 씀), 파랑은 파생(가공했지만 필드 값이 같음), 빨강은 그 데이터를 준 요청 자체가 낭비입니다. 렌더될 때마다 보라색으로 깜빡입니다.

출처 매칭은 `[정확]`(같은 객체 참조), `[파생]`(가공된 객체지만 필드 값이 일치), `[추정]`(화면 글자만 일치) 세 단계로 표시합니다. 요소를 클릭하면 누른 글자와 값이 같은 필드까지 좁힙니다(같은 값이 하나뿐일 때).

### React Query 캐시키 점검

앱이 React Query 를 쓰면 "네트워크 요청 › React Query" 에서 아래를 찾아 줍니다. react-query 를 import 하지 않고 화면의 `QueryClientProvider` 를 찾아 QueryCache 를 구독합니다.

| 지적 | 뜻 |
|---|---|
| 같은 요청을 다른 키로 캐시 | 같은 URL·payload 를 두 queryKey 가 따로 받아 캐시를 나눠 씁니다. |
| 키에 빠진 인자 | 같은 queryKey 로 다른 요청이 나갑니다. 키에 넣지 않은 값이 요청을 바꿉니다. |
| 맞는 쿼리가 없는 무효화 | `invalidateQueries` 의 키가 이 화면의 어떤 쿼리와도 맞지 않습니다. |
| staleTime 0 같은 응답 재요청 | 재마운트·포커스마다 같은 응답을 다시 받습니다. |

### 표시 방식과 유지되는 것

- 패널 오른쪽 위에서 표시 방식을 고릅니다: 작게 보기(▭), 하단 도킹(⬓), 오른쪽 도킹(◨), 별도 창(⧉). 도킹했을 때는 안쪽 가장자리를 끌어 크기를 바꿉니다.
- **같은 탭이면** 새로고침이나 앱 코드 수정(HMR, 전체 리로드)으로 페이지가 다시 열려도 패널 열림·박스·관점과 요청 기록이 이어집니다(sessionStorage). 되살린 요청에는 "새로고침 전" 이 붙고, 응답 원문은 10KB 까지만, 토큰·비밀번호로 보이는 값은 가려서 저장합니다. 렌더 기록은 새로 모읍니다. 탭을 닫으면 사라집니다.
- 표시 방식, 버튼 위치, 무시 목록(의도된 반복으로 지정한 엔드포인트)은 새 탭에서도 이어집니다(localStorage).

## AI 에게 결과 넘기기

rdx 가 모은 결과(엔드포인트별 낭비 요청과 보낸 코드 위치, React Query 지적, 줄일 수 있는 렌더와 그 원인)를 AI 가 읽을 수 있는 JSON 으로 내보냅니다. **응답 본문과 헤더는 넣지 않습니다.** URL 쿼리는 들어갑니다.

### 파일: `.rdx/report.json`

dev 서버에 플러그인을 붙이면 5초마다, 바뀐 내용이 있을 때 `.rdx/report.json` 을 씁니다. 위치는 dev 명령을 실행한 폴더 기준이고, `.rdx/.gitignore` 를 함께 만들어 저장소에 올라가지 않습니다.

```ts
// Vite: vite.config.ts
import { rdx } from 'react-data-xray/vite';

export default defineConfig({ plugins: [react(), rdx()] });
```

```js
// webpack: webpack.config.js
import { rdxReportMiddleware } from 'react-data-xray/middleware';

export default {
  devServer: {
    setupMiddlewares: (middlewares, server) => {
      server.app.use(rdxReportMiddleware());
      return middlewares;
    },
  },
};
```

- 브라우저는 보내기 전에 본문 없는 `GET /__rdx/report` 로 플러그인이 있는지 먼저 묻고, 없으면 아무것도 보내지 않습니다. 플러그인이 없는 dev 서버는 이 경로를 원격 백엔드로 프록시할 수 있기 때문입니다.
- 플러그인은 Host 가 `localhost`·`*.localhost`·IP 주소인 요청만 받습니다(DNS 리바인딩 방지). 다른 이름으로 접속한다면 `rdx({ allowedHosts: ['my-app.local'] })` 로 지정합니다. Vite 는 `server.allowedHosts` 를 그대로 씁니다. 막히면 브라우저 콘솔에 안내가 나옵니다.
- 옵션: `rdx({ dir: '.rdx', allowedHosts: [...] })`, `rdxReportMiddleware(root, { dir, allowedHosts })`.

AI 가 이 파일을 읽게 하려면 `CLAUDE.md` 같은 지침 파일에 한 줄을 둡니다.

```md
화면 성능·요청 문제를 고치기 전에 `.rdx/report.json` 을 읽는다.
```

### 브라우저: `window.__RDX__`

브라우저 도구를 쓰는 AI(또는 콘솔의 개발자)가 직접 부릅니다.

| 함수 | 하는 일 |
|---|---|
| `report()` | 지금까지 모은 보고서를 돌려줍니다. 처음 부를 때 렌더 감시가 꺼져 있었다면 켜고 `renders.monitoring: false` 를 돌려주니, 화면을 조작한 뒤 다시 부릅니다. |
| `reset()` | 측정을 새로 시작합니다. 요청 기록과 렌더 통계를 비웁니다. |
| `snapshot(name)` | 보고서를 `.rdx/<name>.json` 으로 저장하고 돌려줍니다. 고치기 전후 비교에 씁니다. 플러그인이 없거나 쓰지 못하면 거부됩니다. 이름은 영문·숫자·`. _ -` 64자까지이고 `report` 는 쓸 수 없습니다. |

```js
await window.__RDX__.reset();
// … 시나리오 실행 …
await window.__RDX__.snapshot('before-filter');
```

### 보고서에 들어 있는 것

| 필드 | 내용 |
|---|---|
| `requests.endpoints[]` | 엔드포인트별 `count`·`duplicates`·`sameResponses`·`review`(주기·포커스 재요청)·`ignored`, 낭비 URL 예, `callers`(요청을 보낸 코드, 소스맵으로 원본 위치) |
| `reactQuery.findings[]` | 캐시키 점검 지적과 `fix` |
| `renders.components[]` | `renders`·`avoidable`, 이유별 횟수, `causedBy`(렌더를 시작한 조상), `renderedAt`(JSX 위치), `networkCauses`(그 렌더를 일으킨 응답, 같은 응답으로 일어난 렌더 수), `changedProps`, `advice` |
| `howToRead` | 위 필드를 읽는 법(AI 가 따로 문서를 찾지 않아도 되게) |

## AI 스킬: rdx-perf

패키지에 [Claude Code 스킬](./skills/rdx-perf/SKILL.md)이 들어 있습니다. "이 화면 느려", "요청이 너무 많이 나가" 같은 요청에 AI 가 **측정 → 결과 읽기 → 코드에서 원인 확인 → 한 번에 하나씩 수정 → 다시 측정해 전후 비교** 순서로 일하게 합니다.

```bash
# 프로젝트에 설치(팀이 함께 씀)
mkdir -p .claude/skills && cp -r node_modules/react-data-xray/skills/rdx-perf .claude/skills/

# 또는 내 PC 의 모든 프로젝트에
mkdir -p ~/.claude/skills && cp -r node_modules/react-data-xray/skills/rdx-perf ~/.claude/skills/
```

설치한 뒤 Claude Code 에서 "rdx 로 이 화면 성능 점검해 줘" 처럼 부르면 됩니다. 스킬은 보고서 플러그인과 `window.__RDX__` 를 쓰므로 위의 플러그인을 먼저 붙여 두세요. 다른 AI 도구라면 `SKILL.md` 를 그 도구의 지침 파일로 옮겨 쓰면 됩니다.

## 알아 둘 것

**성능.** 측정 도구가 앱을 느리게 하면 측정이 틀어지므로 비싼 일은 나눠서 합니다. 카드 100개, 10초 폴링, 응답 최대 1MB 인 화면에서 박스를 켜 둔 채 메인 스레드 사용은 1% 안팎이었습니다. 렌더 감시는 버튼이 붙어 있는 동안 켜져 있습니다(같은 화면에서 8초에 58ms 정도).

**한계.**

- 박스는 응답 객체를 props 로 받는 컴포넌트에만 그립니다. state 로만 들고 있는 컴포넌트는 요소 선택이나 요청 상세의 "이 요청의 데이터를 쓰는 컴포넌트" 로 찾습니다.
- context 는 값과 바로 아래 한 단계까지만 봅니다.
- 원본 위치(소스맵)는 Vite dev 서버처럼 모듈별로 받는 환경에서만 바꿉니다. 1MB 가 넘는 번들(webpack 등)은 건너뛰어 변환된 위치로 남습니다. 그때는 함수 이름으로 찾습니다.
- 렌더를 그리는 JSX 위치(`renderedAt`)는 React 18 dev 빌드의 `_debugSource` 가 있을 때만 나옵니다.
- WebSocket·SSE·Service Worker 안의 요청은 보지 않습니다.

더 자세한 설계와 한계는 [CONTEXT.md](./docs/CONTEXT.md), 앞으로 할 일은 [ROADMAP.md](./docs/ROADMAP.md)에 있습니다.

## 개발

```bash
pnpm install
pnpm check          # 타입체크 → oxlint → react-doctor → oxfmt 검사 → 테스트·커버리지(80% 이상)
pnpm test           # 테스트만
pnpm fmt            # 포맷 적용
pnpm sync <앱 경로>  # 빌드해서 file: 로 연결한 앱의 node_modules 에 반영한다
```

- `file:` 로 연결한 Vite 앱에서 고치며 볼 때는 앱의 `vite.config` 에 아래 두 줄을 둡니다. 사전 번들에서 빼고 감시하면 `pnpm sync` 만으로 페이지가 새 코드로 다시 열립니다. 넣지 않으면 sync 할 때마다 dev 서버를 `--force` 로 다시 띄워야 하고, import URL 의 `?v=` 해시가 그대로라 브라우저도 이전 모듈을 씁니다.

  ```ts
  server: { watch: { ignored: ['!**/node_modules/react-data-xray/**'] } },
  optimizeDeps: { exclude: ['react-data-xray'] },
  ```

  서버 쪽 코드(미들웨어)를 고쳐 dev 서버를 다시 띄웠다면, 띄운 **뒤에** `pnpm sync` 를 한 번 더 합니다.
- 테스트는 각 폴더의 `__tests__` 에 둡니다. 테스트 안에서 시나리오용 컴포넌트를 그 자리에서 정의하는 것은 의도된 패턴이라, 테스트 폴더에서만 `unicorn/consistent-function-scoping` 을 끕니다(`.oxlintrc.json`). 테스트 픽스처는 rdx 가 관찰할 `useEffect + fetch` 패턴을 일부러 재현하므로 react-doctor 의 `no-fetch-in-effect` 도 테스트 폴더에서만 끕니다(`react-doctor.config.json`).
- react-doctor 는 공급망 검사(의존성 목록을 외부로 보냄)와 사용 통계 전송을 끄고 실행합니다.
- 컴파일 대상은 ES2020 입니다. `toSorted`·`toReversed` 같은 ES2023 메서드는 폴리필 없이 오래된 브라우저에서 깨지므로 쓰지 않고, 이를 권하는 `unicorn/no-array-sort`·`no-array-reverse` 는 끕니다. 대신 복사한 배열에서만 `sort`·`reverse` 합니다.
