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

Next.js treats folders starting with `_` as private and leaves them out of routing, so the first `_` of `__rdx` is written as `%5F` (`%5F_rdx`); the route still answers at `/__rdx/report`. It only answers under `next dev` and returns 404 in `next build`/`next start`. Apps with a `basePath` are not supported yet (the browser sends to `/__rdx/report`).

**Drive it from the terminal (no browser tool)**: with the plugin attached and the app open in a browser tab, the `react-data-xray` command runs `reset` and `snapshot` in that tab through the dev server. Run it in the app folder (inside the app, `pnpm exec rdx` / `npx rdx` is the same command; outside it, `npx rdx` would fetch an unrelated npm package named `rdx`). An AI agent without a browser tool can then run the whole loop on its own.

```bash
npx react-data-xray reset                    # start a fresh measurement in the open tab
# … run the scenario …
npx react-data-xray snapshot before          # saves .rdx/before.json
npx react-data-xray compare before after     # compares .rdx/before.json and .rdx/after.json (any tab, even after a reload)
npx react-data-xray report --summary         # prints .rdx/report.json (only its summary, when this version has one)
npx react-data-xray tabs                     # tabs connected to the dev server
```

- The dev server address is found in `.rdx/.server.json` (the plugin writes the address the browser uses). Pass `--url http://localhost:5173` (or `RDX_URL`) if the app has not been opened yet or the server moved.
- Cost and latency: while no CLI/MCP is in use, an open tab checks for commands once a minute (a tiny bodyless GET; changed reports are still uploaded every 5s and also carry commands). After any CLI/MCP request the dev server tells tabs to check every 5s for the next 10 minutes. So the first command can take up to a minute to arrive, later ones about 5s; a tab hidden for a long time may still answer only once a minute.
- Without `--tab <id>`, it runs in the visible tab focused most recently (or the only tab). If several tabs are visible and none was focused in the last 2 minutes, it does not guess: it exits with 6 and lists the tabs. Page paths and titles in that list are set by the page, so they are shown quoted, with control characters removed, as data.
- Security: every `/__rdx/command` request needs the random token the dev server writes to `.rdx/.server.json` when it starts serving (the CLI reads it), so other devices on the LAN (`vite --host`) and other sites cannot drive your tabs. Tabs only register when their request carries the `x-rdx-tab` header, which other sites cannot send without a CORS preflight.
- Exit codes: `0` ok, `1` failed in the tab, `2` usage, `3` dev server unreachable, without rdx, or token rejected, `4` no tab connected, `5` timed out, `6` several tabs and none focused recently (pass `--tab`).
- Next.js: add `app/%5F_rdx/command/[[...id]]/route.ts` with the same line, `export { GET, POST } from 'react-data-xray/next'`.
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
| `requests.total` · `dropped` | Number of requests recorded; number dropped when the 200-record limit was exceeded. If `dropped` is non-zero, split the scenario into shorter runs |
| `requests.endpoints[]` | Per-endpoint `count` · `duplicates` · `sameResponses` · `review` (polling, focus refetch) · `ignored`, example waste URLs, `callers` (code that sent the request) |
| `reactQuery.findings[]` | Cache key audit findings with `fix` |
| `renders.windowSeconds` | The window covered by render data. After `reset()`: everything since then (up to 2 min). Otherwise: the last 10s |
| `renders.truncated` · `droppedInstances` | Whether rendered instances exceeded 5000 and the count excluded (those with fewest renders). When true, `components[]` counts may be lower than actual |
| `renders.components[]` | `renders` · `avoidable`, per-reason counts, `stateChanges` (changed hooks and periodicity), `startedRenders` (child renders started by this component and which props changed), `causedBy`, `renderedAt`, `networkCauses`, `changedProps`, `advice` |
| `resetAt` | ms epoch of the last `reset()` call in this tab; `null` if never reset. When comparing two snapshots, check that both have a `resetAt` — if only one does, the comparison may mix post-reset and pre-reset data |
| `diagnostics` | Same as `window.__RDX__.doctor()`: `renderHook` (`commitsSeen`, `reactVersion`, `strictMode`: `null` until a render was recorded), `capture` (`requestsBeforeInstall`), `requests` (`recorded`, `restored`, `jsonResponses`), `reportPlugin` (`ready` · `missing` · `forbidden-host` · `checking`), `sourceMaps.failures`, `sameResponseMemory`, and `problems` with how to fix each. Read `problems` first: if rdx loaded after react-dom, render data is empty and early requests are missing |
| `howToRead` | How to interpret the fields above |

- `snapshot(name)`: name may contain letters, digits, and `. _ -`, up to 64 characters; `report` is reserved. Rejected if the plugin is not running.
- Security: to prevent other sites from injecting fake reports, the plugin accepts requests only from `localhost`, `*.localhost`, and IP addresses. For other hostnames use `rdx({ allowedHosts: ['my-app.local'] })`. Vite reuses `server.allowedHosts` automatically.
- Options: `rdx({ dir: '.rdx', allowedHosts: [...], inject: false })`, `rdxReportMiddleware(root, { dir, allowedHosts })`, `export const { GET, POST } = createRdxReportRoute(root, { dir, allowedHosts })` from `react-data-xray/next`. `inject: true` (Vite 4+) adds `import 'react-data-xray'` to the `index.html` Vite serves, running before the app's entry module, so the entry file needs only `<RdxDevtools />`. It does nothing when Vite does not serve the HTML (SSR, framework modes, backend integrations); see README.
- CLI options: `--url`, `--tab <id>`, `--dir` (when the plugin uses another `dir`), `--timeout <seconds>` (default 90). `rdx --help` lists them.

</details>
