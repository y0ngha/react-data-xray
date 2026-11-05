# Using rdx with an AI agent

Back to [README](../README.md)

Use this when you want to hand off "this screen is slow" or "too many requests" to an AI. rdx exports what the AI needs to read — measurements, root causes — so the AI can measure, find the cause, fix it, and measure again. Response bodies and headers are not included (URL query strings are).

**Read from the browser**: for an AI that controls the browser, or call from the console.

```js
window.__RDX__.reset();                   // start a fresh measurement
// … interact with the page …
const report = await window.__RDX__.report();
window.__RDX__.doctor();                  // is rdx attached? same as report.diagnostics
await window.__RDX__.snapshot('before');  // saves to .rdx/before.json (plugin required, see below)
                                          // or Measure › Save in the panel toolbar (same effect)
```

**Read from a file**: attach the plugin to your dev server and it will write `.rdx/report.json` whenever the report changes (at most every 5s). A `.gitignore` entry is created automatically.

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

```ts
// Next.js App Router: app/%5F_rdx/report/route.ts (src/app/... if you use a src folder)
export { GET, POST } from 'react-data-xray/next';
```

Next.js treats folders starting with `_` as private and leaves them out of routing, so the first `_` of `__rdx` is written as `%5F` (`%5F_rdx`); the route still answers at `/__rdx/report`. It only answers under `next dev` and returns 404 in `next build`/`next start`. With a `basePath`, keep the route file where it is (Next serves it at `<basePath>/__rdx/report`) and call `configure({ reportPath: '<basePath>/__rdx/report' })` in the browser entry (see README).

Add one line to your AI instruction file (`CLAUDE.md`, etc.): `Before fixing a performance or request problem, read .rdx/report.json.`

If you use Claude Code, copy the [`rdx-perf`](../skills/rdx-perf/SKILL.md) skill from the package. It runs the full measure → diagnose → fix → re-measure loop when you say things like "this screen is slow".

```bash
mkdir -p .claude/skills && cp -r node_modules/react-data-xray/skills/rdx-perf .claude/skills/
```

<details>
<summary><b>Report fields and plugin options</b></summary>

| Field | Contents |
|---|---|
| `summary` | Read first. `verdict` (one-line count), `badge` (the RDX button badge count and its breakdown), `topFindings[]` (up to 10, in fix order: `kind`, `severity`, `target` with location, `evidence`, estimated `savings`, `fix`, `detail` path to the full entry), `omitted` |
| `requests.total` · `dropped` | Number of requests recorded; number dropped when the record limit (`config.maxRecords`, default 200) was exceeded. If `dropped` is non-zero, split the scenario into shorter runs |
| `requests.endpoints[]` | Per-endpoint `count` · `duplicates` · `sameResponses` · `review` (polling, focus refetch) · `ignored` (in the panel or by `config.ignore`), example waste URLs, `callers` (code that sent the request) |
| `requests.waterfalls[]` | Serial request chains (up to 5, largest latency first): a response mounted the component that sent the next request. `chain[]` (`endpoint`, `component`, `location`, `ms`), `depth` (requests in the chain), `latencyMs` (sum of response times), `count`. Requests sent in parallel are not chained |
| `reactQuery.findings[]` | Cache key audit findings with `fix` |
| `renders.windowSeconds` | The window covered by render data. After `reset()`: everything since then (up to 2 min). Otherwise: the last 10s |
| `renders.truncated` · `droppedInstances` | Whether rendered instances exceeded 5000 and the count excluded (those with fewest renders). When true, `components[]` counts may be lower than actual |
| `renders.components[]` | `renders` · `avoidable`, per-reason counts, `stateChanges` (changed hooks and periodicity), `startedRenders` (child renders started by this component and which props changed), `causedBy`, `renderedAt`, `networkCauses`, `changedProps`, `advice` |
| `complete` · `incompleteReasons` · `pendingAnalysis` · `sourcesResolved` · `queryKeysResolved` | Whether all analysis that feeds the report had finished. `incompleteReasons`: `pending-analysis` (`pendingAnalysis` steps still queued), `source-maps` (still resolving), `source-map-timeout` (`snapshot()` waited 2s and gave up), `query-keys` (React Query contexts not looked up yet). The periodic `.rdx/report.json` waits for none of these; `report()` finishes the queue but does not wait for source maps; `snapshot()` finishes the queue and waits up to 2s for source maps. Compare only reports with `complete: true` |
| `resetAt` | ms epoch of the last `reset()` call in this tab; `null` if never reset. When comparing two snapshots, check that both have a `resetAt` — if only one does, the comparison may mix post-reset and pre-reset data |
| `diagnostics` | Same as `window.__RDX__.doctor()`: `renderHook` (`commitsSeen`, `reactVersion`, `strictMode`: `null` until a render was recorded), `capture` (`requestsBeforeInstall`), `requests` (`recorded`, `restored`, `jsonResponses`), `reportPlugin` (`ready` · `missing` · `forbidden-host` · `checking`), `sourceMaps.failures`, `sameResponseMemory`, and `problems` with how to fix each. Read `problems` first: if rdx loaded after react-dom, render data is empty and early requests are missing |
| `config` | Detection settings in effect, set in code with `configure()` (see README) or the defaults: `ignore` (`code`: `configure()` endpoint names and `/RegExp/` strings; `panel`: chosen in the panel), `keyHeaders`, `dedupeWindowMs` (2000), `burst` (`{ windowMs: 500, count: 5 }`), `maxRecords` (200, max 5000), `reportPath` (`/__rdx/report`). `compare` warns when the detection criteria differ (`dedupeWindowMs`, `burst`, `keyHeaders`, `ignore`, and `maxRecords` when either report dropped requests) — their counts are not directly comparable |
| `howToRead` · `howToReadVersion` | How to interpret the fields above, and its version. `report({ howToRead: false })` leaves `howToRead` out (files written by the plugin always include it) |

- `snapshot(name)`: name may contain letters, digits, and `. _ -`, up to 64 characters; `report` is reserved. Rejected if the plugin is not running.
- Security: to prevent other sites from injecting fake reports, the plugin accepts requests only from `localhost`, `*.localhost`, and IP addresses. For other hostnames use `rdx({ allowedHosts: ['my-app.local'] })`. Vite reuses `server.allowedHosts` automatically.
- Options: `rdx({ dir: '.rdx', allowedHosts: [...], inject: false, path: '/__rdx/report' })`, `rdxReportMiddleware(root, { dir, allowedHosts, path })` (`path` must match the browser's `configure({ reportPath })`), `export const { GET, POST } = createRdxReportRoute(root, { dir, allowedHosts })` from `react-data-xray/next`. `inject: true` (Vite 4+) adds `import 'react-data-xray'` to the `index.html` Vite serves, running before the app's entry module, so the entry file needs only `<RdxDevtools />`. It does nothing when Vite does not serve the HTML (SSR, framework modes, backend integrations); see README.

</details>
