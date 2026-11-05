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

**Drive it from the terminal (no browser tool)**: with the plugin attached and the app open in a browser tab, the `react-data-xray` command runs `reset` and `snapshot` in that tab through the dev server. Run it in the app folder (inside the app, `pnpm exec rdx` / `npx rdx` is the same command; outside it, `npx rdx` would fetch an unrelated npm package named `rdx`). An AI agent without a browser tool can then run the whole loop on its own.

```bash
npx react-data-xray reset                    # start a fresh measurement in the open tab
# … run the scenario …
npx react-data-xray snapshot before          # saves .rdx/before.json
npx react-data-xray compare before after     # compares .rdx/before.json and .rdx/after.json (any tab, even after a reload)
npx react-data-xray report --summary         # prints .rdx/report.json (only its summary, when this version has one)
npx react-data-xray tabs                     # tabs connected to the dev server
```

- The dev server address is found in `.rdx/.server.json`: the plugin writes its own listening address there (never an address taken from a request). Next.js route handlers cannot see their own address, so with Next.js pass `--url http://localhost:3000` (or `RDX_URL`); also pass it if the server moved.
- Cost and latency: while no CLI/MCP is in use, an open tab checks for commands every 55s (a tiny bodyless GET; changed reports are still uploaded every 5s and also carry commands). After any CLI/MCP request the dev server tells tabs to check every 5s for the next 10 minutes. So the first command can take up to a minute to arrive, later ones about 5s; a tab hidden for a long time (the browser wakes it once a minute) still checks on every wake.
- Timeouts: a command that a tab has not run by the CLI's `--timeout` is dropped and will not run later; on timeout or Ctrl+C the CLI withdraws it (MCP does the same when the client cancels a tool call). If the tab had already received it, the CLI says it may have run.
- Without `--tab <id>`, it runs in the visible tab focused most recently (or the only tab). If several tabs are visible and none was focused in the last 2 minutes, it does not guess: it exits with 6 and lists the tabs. Page paths and titles in that list are set by the page, so they are shown quoted, with control characters removed, as data.
- Security: every `/__rdx/command` request needs the random token the dev server writes to `.rdx/.server.json` (readable only by you, mode 0600) and must come from this machine. Tabs register and receive commands only from this machine too (loopback), and only when their request carries the `x-rdx-tab` header, which other sites cannot send without a CORS preflight. So other devices on the LAN (`vite --host`) and other sites cannot drive or impersonate your tabs. To drive a tab opened on another device, opt in with `rdx({ commands: 'lan' })` (or `rdxReportMiddleware(root, { commands: 'lan' })`): then any device on the network can register a fake tab and receive your commands, though it still cannot send commands without the token. Next.js has no socket address, so it decides "this machine" by the Host name only.
- Exit codes: `0` ok, `1` failed in the tab, `2` usage, `3` dev server unreachable, without rdx, or token rejected, `4` no tab connected, `5` timed out, `6` several tabs and none focused recently (pass `--tab`).
- Next.js: add `app/%5F_rdx/command/[[...id]]/route.ts` with `export { GET, POST, DELETE } from 'react-data-xray/next'`, and pass `--url`.
- Only `reset` and `snapshot` can be sent; the command path runs no other code and has the same Host/Origin checks as the report path.

**MCP server**: `react-data-xray mcp` exposes the same actions (`reset`, `snapshot`, `compare`, `report`, `tabs`) as MCP tools over stdio. Run in the app folder:

```bash
claude mcp add rdx -- npx react-data-xray mcp            # add --url http://localhost:5173 after mcp if needed
```

Add one line to your AI instruction file (`CLAUDE.md`, etc.): `Before fixing a performance or request problem, read .rdx/report.json.`

If you use Claude Code, copy the [`rdx-perf`](../skills/rdx-perf/SKILL.md) skill from the package. It runs the full measure → diagnose → fix → re-measure loop when you say things like "this screen is slow".

```bash
mkdir -p .claude/skills && cp -r node_modules/react-data-xray/skills/rdx-perf .claude/skills/
```

<details>
<summary><b>Report fields and plugin options</b></summary>

| Field | Contents |
|---|---|
| `summary` | Read first. `verdict` (one-line count), `badge` (the RDX button badge count and its breakdown), `topFindings[]` (up to 10, in fix order: `kind`, `severity`, `target` with location and `id` of the row to fix, `evidence`, estimated `savings`, `fix`, `detail` path to the full entry), `omitted` |
| `id` · `endpointId` · `componentId` | String ids that link the same endpoint or component across sections, `summary` and `compare`, stable across runs (built from names and locations, not numbers): endpoint `ep:<endpoint>` (e.g. `ep:GET /items/:id`), component `c:<name>@<renderedAt>` (`c:<name>` when the JSX location is unknown). Rows carry `id` (`requests.endpoints[]`, `renders.components[]`, `causedBy[]`, `heaviestCommits[].startedBy`); references carry `endpointId` / `componentId` (`networkCauses`, `requests.nPlusOne`, `requests.waterfalls[].chain`, `requests.bursts[].topEndpoints`, `layoutShifts`; `mutationId` / `refetchedId` in `requests.followUps`, `summary.topFindings[].target`). A name-only `componentId` (the sending component of a request) matches the `renders.components` rows whose id starts with `c:<name>@` |
| `requests.total` · `dropped` | Number of requests recorded; number dropped when the record limit (`config.maxRecords`, default 200) was exceeded. If `dropped` is non-zero, split the scenario into shorter runs |
| `requests.endpoints[]` | Per-endpoint `count` · `duplicates` · `sameResponses` · `review` (polling, focus refetch) · `ignored` (in the panel or by `config.ignore`), example waste URLs, `unused` · `unusedExamples` (responses no component was found holding a few seconds after they arrived — review, not waste), `callers` (code that sent the request), `renders` (renders its responses caused in the render window: `count` · `ms`, the `viaParent` part, and the `fromSameResponse` part that a removed refetch would save; `ms` is dev-build `selfBaseDuration`, compare it rather than read it as absolute) |
| `requests.bursts[]` · `burstsOmitted` | Request bursts (`config.burst`: 5+ requests within 500ms), the same as the timeline: `from` · `to` (ms epoch), `count`, `kind` (`entry` right after page load or navigation, `waste` otherwise), `reason` (`initial-load` · `navigation` · `no-entry`), `wasted` (duplicates and same responses in it), `route`, `topEndpoints`, `overlaps` (requests already counted by an endpoint row or `nPlusOne` entry; summary leaves them out of the burst's savings). Requests to ignored endpoints are not counted. Waste first, at most 20 |
| `requests.followUps[]` | GET requests sent within 1s after a mutation response, each attributed to the nearest preceding mutation only (pre-reload records left out), the same as the request detail: `mutation` (method + endpoint), `refetched`, `mutations`, `count`, `sameResponse` (unchanged responses: the invalidation is broader than the change), `queryKey`, `periodic` (polling, may be unrelated), `ignored` (mutation or refetched endpoint ignored) |
| `requests.nPlusOne[]` | Requests sent once per list item (N+1): `config.nPlusOne.count` (5)+ different IDs to the same endpoint (an `:id` path segment) from the same `component` (or the same caller `location` when unknown) within `config.nPlusOne.windowMs` (1000). `count` (different IDs), `windowMs`, `examples` (URLs). Ignored endpoints are left out. Review, not waste |
| `requests.waterfalls[]` | Serial request chains (up to 5, largest latency first): a response mounted the component that sent the next request. `chain[]` (`endpoint`, `component`, `location`, `ms`), `depth` (requests in the chain), `latencyMs` (sum of response times), `count`. Requests sent in parallel are not chained |
| `reactQuery.findings[]` | Cache key audit findings with `fix`; `stack` / `stacks` are the `invalidateQueries` call sites, up to 3 app-code frames, source-mapped like `callers` |
| `renders.windowSeconds` | The window covered by render data. After `reset()`: everything since then (up to 2 min). Otherwise: the last 10s |
| `renders.truncated` · `droppedInstances` | Whether rendered instances exceeded 5000 and the count excluded (those with fewest renders). When true, `components[]` counts may be lower than actual |
| `renders.components[]` | `renders` · `avoidable`, per-reason counts, `stateChanges` (changed hooks and periodicity), `startedRenders` (child renders started by this component and which props changed), `causedBy` (the ancestor that started the render, with its `renderedAt` and `id`), `renderedAt`, `networkCauses`, `changedProps`, `advice` |
| `complete` · `incompleteReasons` · `pendingAnalysis` · `sourcesResolved` · `queryKeysResolved` | Whether all analysis that feeds the report had finished. `incompleteReasons`: `pending-analysis` (`pendingAnalysis` steps still queued), `source-maps` (still resolving), `source-map-timeout` (`snapshot()` waited 2s and gave up), `query-keys` (React Query contexts not looked up yet). The periodic `.rdx/report.json` waits for none of these; `report()` finishes the queue but does not wait for source maps; `snapshot()` finishes the queue and waits up to 2s for source maps. Compare only reports with `complete: true` |
| `resetAt` | ms epoch of the last `reset()` call in this tab; `null` if never reset. When comparing two snapshots, check that both have a `resetAt` — if only one does, the comparison may mix post-reset and pre-reset data |
| `layoutShifts[]` | Layout shifts since the last `reset()` (or page load), largest first, up to 20; shifts right after user input are left out. `value` (shift score), `component` · `renderedAt` (the component that moved), `cause` (`endpoint` and `component` of the response that rendered it in the commit before the shift; `inferred: true` when it was only guessed from the latest response-driven commit, e.g. a sibling above grew), `causeUnavailable: 'render-monitoring-off'` (render monitoring was off at the time). Absent in browsers that do not report layout shifts (Safari, Firefox) |
| `diagnostics` | Same as `window.__RDX__.doctor()`: `renderHook` (`commitsSeen`, `reactVersion`, `strictMode`: `null` until a render was recorded), `capture` (`requestsBeforeInstall`), `requests` (`recorded`, `restored`, `jsonResponses`), `reportPlugin` (`ready` · `missing` · `forbidden-host` · `checking`), `sourceMaps.failures`, `sameResponseMemory`, and `problems` with how to fix each. Read `problems` first: if rdx loaded after react-dom, render data is empty and early requests are missing |
| `config` | Detection settings in effect, set in code with `configure()` (see README) or the defaults: `ignore` (`code`: `configure()` endpoint names and `/RegExp/` strings; `panel`: chosen in the panel), `keyHeaders`, `dedupeWindowMs` (2000), `burst` (`{ windowMs: 500, count: 5 }`), `nPlusOne` (`{ windowMs: 1000, count: 5 }`), `maxRecords` (200, max 5000), `reportPath` (`/__rdx/report`). `compare` warns when the detection criteria differ (`dedupeWindowMs`, `burst`, `nPlusOne`, `keyHeaders`, `ignore`, and `maxRecords` when either report dropped requests) — their counts are not directly comparable |
| `howToRead` · `howToReadVersion` | How to interpret the fields above, and its version. `report({ howToRead: false })` leaves `howToRead` out (files written by the plugin always include it) |

- `snapshot(name)`: name may contain letters, digits, and `. _ -`, up to 64 characters; `report` is reserved. Rejected if the plugin is not running.
- Security: to prevent other sites from injecting fake reports, the plugin accepts requests only from `localhost`, `*.localhost`, and IP addresses. For other hostnames use `rdx({ allowedHosts: ['my-app.local'] })`. Vite reuses `server.allowedHosts` automatically.
- Options: `rdx({ dir: '.rdx', allowedHosts: [...], inject: false, path: '/__rdx/report', commands: 'local' })`, `rdxReportMiddleware(root, { dir, allowedHosts, path, commands })` (`path` must match the browser's `configure({ reportPath })`), `export const { GET, POST, DELETE } = createRdxReportRoute(root, { dir, allowedHosts, commands })` from `react-data-xray/next`. `inject: true` (Vite 4+) adds `import 'react-data-xray'` to the `index.html` Vite serves, running before the app's entry module, so the entry file needs only `<RdxDevtools />`. It does nothing when Vite does not serve the HTML (SSR, framework modes, backend integrations); see README.
- CLI options: `--url`, `--tab <id>`, `--dir` (when the plugin uses another `dir`), `--timeout <seconds>` (default 90). `react-data-xray --help` lists them. With a custom `path`, the command path moves with it (`/x/report` → `/x/command`, otherwise `<path>/command`); the plugin records it in `.rdx/.server.json` and the CLI follows it.

</details>
