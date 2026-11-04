# Using rdx with an AI agent

Back to [README](../README.md)

Use this when you want to hand off "this screen is slow" or "too many requests" to an AI. rdx exports what the AI needs to read — measurements, root causes — so the AI can measure, find the cause, fix it, and measure again. Response bodies and headers are not included (URL query strings are).

**Read from the browser**: for an AI that controls the browser, or call from the console.

```js
window.__RDX__.reset();                   // start a fresh measurement
// … interact with the page …
const report = await window.__RDX__.report();
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

**Drive it from the terminal (no browser tool)**: with the plugin attached and the app open in a browser tab, the `rdx` command runs `reset` and `snapshot` in that tab through the dev server. An AI agent without a browser tool can then run the whole loop on its own.

```bash
npx rdx reset                    # start a fresh measurement in the open tab
# … run the scenario …
npx rdx snapshot before          # saves .rdx/before.json
npx rdx compare before after     # compares .rdx/before.json and .rdx/after.json (any tab, even after a reload)
npx rdx report --summary         # prints .rdx/report.json (only its summary, when this version has one)
npx rdx tabs                     # tabs connected to the dev server
```

- The dev server address is found in `.rdx/.server.json` (the plugin writes the address the browser uses). Pass `--url http://localhost:5173` (or `RDX_URL`) if the app has not been opened yet or the server moved.
- The command reaches the tab with its next 5-second upload, so it takes up to about 5s (a tab hidden for a long time may answer only once a minute). Without `--tab <id>`, it runs in the most recently active tab and lists the others.
- Exit codes: `0` ok, `1` failed in the tab, `2` usage, `3` dev server unreachable or without rdx, `4` no tab connected, `5` timed out.
- Next.js: add `app/%5F_rdx/command/[[...id]]/route.ts` with the same line, `export { GET, POST } from 'react-data-xray/next'`.
- Only `reset` and `snapshot` can be sent; the command path runs no other code and has the same Host/Origin checks as the report path.

**MCP server**: `rdx mcp` exposes the same actions (`reset`, `snapshot`, `compare`, `report`, `tabs`) as MCP tools over stdio. Run in the app folder:

```bash
claude mcp add rdx -- npx rdx mcp            # add --url http://localhost:5173 after mcp if needed
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
| `howToRead` | How to interpret the fields above |

- `snapshot(name)`: name may contain letters, digits, and `. _ -`, up to 64 characters; `report` is reserved. Rejected if the plugin is not running.
- Security: to prevent other sites from injecting fake reports, the plugin accepts requests only from `localhost`, `*.localhost`, and IP addresses. For other hostnames use `rdx({ allowedHosts: ['my-app.local'] })`. Vite reuses `server.allowedHosts` automatically.
- Options: `rdx({ dir: '.rdx', allowedHosts: [...], inject: false })`, `rdxReportMiddleware(root, { dir, allowedHosts })`, `export const { GET, POST } = createRdxReportRoute(root, { dir, allowedHosts })` from `react-data-xray/next`. `inject: true` (Vite 4+) adds `import 'react-data-xray'` to the `index.html` Vite serves, running before the app's entry module, so the entry file needs only `<RdxDevtools />`. It does nothing when Vite does not serve the HTML (SSR, framework modes, backend integrations); see README.
- CLI options: `--url`, `--tab <id>`, `--dir` (when the plugin uses another `dir`), `--timeout <seconds>` (default 90). `rdx --help` lists them.

</details>
