# AI 에이전트와 함께 쓰기

[README](../README.md) 로 돌아가기

AI 에게 "이 화면 느려", "요청이 너무 많이 나가"라고 맡길 때 쓰는 기능입니다. 화면에서 보는 결과를 AI 도 읽을 수 있게 내보내서, AI 가 측정하고 원인을 찾고 고친 뒤 다시 재게 합니다. 응답 본문과 헤더는 넣지 않습니다(URL 쿼리는 들어갑니다).

**브라우저에서 바로 읽기**: 브라우저를 다루는 AI 나 콘솔에서 부릅니다.

```js
await window.__RDX__.reset();             // 측정을 새로 시작
// … 화면 조작 …
const report = await window.__RDX__.report();
await window.__RDX__.snapshot('before');  // .rdx/before.json 으로 저장 (아래 플러그인 필요)
```

**파일로 읽기**: 개발 서버에 플러그인을 붙이면 바뀐 내용이 있을 때마다(최대 5초에 한 번) `.rdx/report.json` 을 씁니다. 저장소에 올라가지 않게 `.gitignore` 도 함께 만듭니다.

```ts
// vite.config.ts
import { rdx } from 'react-data-xray/vite';
export default defineConfig({ plugins: [react(), rdx()] });
```

```js
// webpack.config.js
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

Next.js 개발 서버에는 아직 이 플러그인을 붙일 방법이 없어 `window.__RDX__` 로 읽습니다.

AI 지침 파일(`CLAUDE.md` 등)에는 `화면 성능·요청 문제를 고치기 전에 .rdx/report.json 을 읽는다.` 한 줄이면 됩니다. Claude Code 를 쓴다면 패키지의 스킬 [`rdx-perf`](../skills/rdx-perf/SKILL.md)를 복사해 두세요. "이 화면 느려" 같은 요청에 측정 → 원인 확인 → 수정 → 다시 측정 순서로 일합니다.

```bash
mkdir -p .claude/skills && cp -r node_modules/react-data-xray/skills/rdx-perf .claude/skills/
```

<details>
<summary><b>보고서 필드와 플러그인 옵션</b></summary>

| 필드 | 내용 |
|---|---|
| `requests.total`·`dropped` | 기록한 요청 수, 기록 상한(200건)을 넘어 빠진 수. `dropped` 가 있으면 시나리오를 짧게 나눕니다 |
| `requests.endpoints[]` | 엔드포인트별 `count`·`duplicates`·`sameResponses`·`review`(주기·포커스 재요청)·`ignored`, 낭비 URL 예, `callers`(요청을 보낸 코드) |
| `reactQuery.findings[]` | 캐시 키 점검 지적과 `fix` |
| `renders.windowSeconds` | 렌더를 센 구간. `reset()` 했으면 그 뒤 전부(최대 2분), 아니면 최근 10초 |
| `renders.truncated`·`droppedInstances` | 렌더된 인스턴스가 5000개를 넘어 렌더 적은 인스턴스를 센 대상에서 뺐는지와 그 수. 빠졌으면 `components[]` 의 횟수가 실제보다 적을 수 있습니다 |
| `renders.components[]` | `renders`·`avoidable`, 이유별 횟수, `stateChanges`(바뀐 훅과 주기), `startedRenders`(이 컴포넌트가 일으킨 하위 렌더와 값이 바뀐 props), `causedBy`, `renderedAt`, `networkCauses`, `changedProps`, `advice` |
| `howToRead` | 위 필드를 읽는 법 |

- `snapshot(name)`: 이름은 영문·숫자·`. _ -` 64자까지이고 `report` 는 쓸 수 없습니다. 플러그인이 없으면 거부됩니다.
- 보안: 다른 사이트가 가짜 보고서를 보내지 못하게, 플러그인은 `localhost`·`*.localhost`·IP 주소로 들어온 요청만 받습니다. 다른 이름으로 접속한다면 `rdx({ allowedHosts: ['my-app.local'] })` 로 지정합니다. Vite 는 `server.allowedHosts` 를 그대로 씁니다.
- 옵션: `rdx({ dir: '.rdx', allowedHosts: [...] })`, `rdxReportMiddleware(root, { dir, allowedHosts })`.

</details>
