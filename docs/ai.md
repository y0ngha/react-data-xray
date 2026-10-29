# Using rdx with an AI agent

Back to [README](../README.md)

Use this when you want to hand off "this screen is slow" or "too many requests" to an AI. rdx exports what the AI needs to read — measurements, root causes — so the AI can measure, find the cause, fix it, and measure again. Response bodies and headers are not included (URL query strings are).

**Read from the browser**: for an AI that controls the browser, or call from the console.

```js
window.__RDX__.reset();                   // start a fresh measurement
// … interact with the page …
const report = await window.__RDX__.report();
await window.__RDX__.snapshot('before');  // saves to .rdx/before.json (plugin required, see below)
                                          // or use the panel's Save button (same effect)
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

There is currently no way to attach the plugin to a Next.js dev server; use `window.__RDX__` instead.

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
- Options: `rdx({ dir: '.rdx', allowedHosts: [...] })`, `rdxReportMiddleware(root, { dir, allowedHosts })`.

</details>
