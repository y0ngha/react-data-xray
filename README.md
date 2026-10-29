[한국어](./README.ko.md)

<div align="center">

# react-data-xray (RDX)

**Click a value on screen to see which API response field it came from,<br/>and find wasted requests and renders in your React app**

[![React](https://img.shields.io/badge/React-%E2%89%A518-black?style=flat)](#supported-environments)
[![license](https://img.shields.io/badge/license-MIT-black?style=flat)](./LICENSE)

<img src="./docs/media/hero-pick.gif" alt="Clicking a row in search results shows that the text came from GET /api/search response at $[0].name" width="860" />

</div>

Answer questions you used to chase across the Network tab and React DevTools, right on the page you are building.

- **Where did this value come from**: click an element to see the request URL, the path inside the response (`$.data.summary.total`), and the React Query key.
- **Why is the same request going out again**: count calls and duplicates per endpoint, same-response refetches, and show the caller code.
- **Why does this keep re-rendering**: show which state changed and how often, which component and response caused the render, and how to fix it.
- **Are the React Query cache keys right**: find requests cached under different keys for the same data, or keys missing an argument.

Use it to check a screen the first time you attach RDX, to compare before and after a fix with `reset` → interact → `snapshot`, or to audit wasted requests and renders before a PR or QA pass.

| Tool you already use | What it shows | What RDX adds |
|---|---|---|
| Network tab | Which requests went out | Which component on screen uses that response |
| React DevTools | Props, state, render time | Which request that value came from, which response caused the render |
| TanStack Query Devtools | Queries and keys in the cache | Which component uses each, where the key design is wrong |

## Supported environments

- React 18, 19. Works only in the dev server — does nothing in a production build.
- Vite, Create React App, Next.js App Router (15.3+). Pages Router is not verified yet.
- JSON responses from `fetch` and `XMLHttpRequest`. Works with any data-fetching library (React Query, SWR, axios, redux, etc.).

## Getting started

### 1. Install

RDX is not on npm yet. Clone the repo, build it, and link it to your app. You need [pnpm](https://pnpm.io) to build.

```bash
git clone https://github.com/y0ngha/react-data-xray.git
cd react-data-xray && pnpm install && pnpm build

# In your app folder. If both folders are side by side, the path is ../react-data-xray
pnpm add -D file:../react-data-xray   # npm i -D file:../react-data-xray, yarn add -D file:../react-data-xray
```

### 2. Add to your app

`import 'react-data-xray'` starts watching requests and renders. `<RdxDevtools />` shows the button and panel in the bottom-right corner. Put the import before all other imports — anything that runs before it will not be captured.

```tsx
// main.tsx (or index.tsx for Create React App)
import 'react-data-xray';
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

<details>
<summary><b>Next.js App Router</b></summary>

Next.js has no single entry file, so put the import in `instrumentation-client.ts` (runs in the browser before React). Drop `src/` from the path if you are not using a `src` folder.

```ts
// At the top of src/instrumentation-client.ts
import 'react-data-xray';
```

Put the panel inside a `'use client'` Provider. If you already have a Provider file, add one line.

```tsx
// src/app/providers.tsx: the root layout wraps children with <Providers>{children}</Providers>
'use client';
import { RdxDevtools } from 'react-data-xray';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <RdxDevtools />
    </>
  );
}
```

</details>

### 3. Try it

1. Open the panel with the **RDX** button in the bottom-right corner.
2. Click **⌖ Pick element** (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd>), then click any number or text that came from an API.
3. If the panel shows `GET /api/...` and a path like `$[0].name`, it is working. Use the **Network** and **Renders** tabs to see the same component from different angles.

<details>
<summary><b>Troubleshooting</b></summary>

- **The button does not appear**: check that `<RdxDevtools />` is actually rendered and that you are on the dev server.
- **Early requests are missing**: make sure `import 'react-data-xray'` comes before all other imports. For Next.js, `instrumentation-client.ts` must sit at the same level as the `app` folder (inside `src/` if you use one).
- **Clicking shows no source**: check that the value comes from a JSON response. Data rendered on the server is not traced.
- **Shortcut conflicts with the browser**: use the panel button, or change it with `<RdxDevtools hotkey={{ key: 'x', shift: true }} />`.

</details>

## Problems it finds

### Response → render → request again — a loop that never ends

In a notification popup in a production service (Next.js 16, React 19), a `useEffect` listed the state it fills as a dependency. Every response changed that state, re-ran the effect, and sent 1,713 requests in six seconds.

<table>
  <tr>
    <td width="50%" align="center"><b>Before</b></td>
    <td width="50%" align="center"><b>After</b></td>
  </tr>
  <tr>
    <td><img src="./docs/media/loop-before.gif" alt="Before: /api/notices requests pile up without stopping, and the Renders tab points to the loop" /></td>
    <td><img src="./docs/media/loop-after.gif" alt="After: /api/notices fires only once" /></td>
  </tr>
</table>

The Network tab only shows the pile-up; React DevTools only shows frequent renders. RDX connects the two: "this component re-renders on every response, and the request goes out again from `useNoticePopup`'s `useEffect`." → [Full video](./docs/media/rdx-effect-loop-before-after.mp4)

### One button label re-renders the whole page every second

In the same service, a countdown button ("Re-analyze available in 0:18") had its remaining time held in state by a parent component, which ticked every second and caused the entire analysis panel to re-render.

<table>
  <tr>
    <td width="50%" align="center"><b>Before</b></td>
    <td width="50%" align="center"><b>After</b></td>
  </tr>
  <tr>
    <td><img src="./docs/media/cooldown-before.gif" alt="Before: ChartContent's useState changes every second and re-renders all children" /></td>
    <td><img src="./docs/media/cooldown-after.gif" alt="After: only ReanalyzeButton re-renders" /></td>
  </tr>
</table>

RDX pointed out: "this state changes every second but only one prop reaching the button actually changes — move the state closer to the button." After the fix, renders in a 10-second window dropped from 80 to 10. → [Full video](./docs/media/rdx-cooldown-before-after.mp4)

### Diagnose with the report, fix with AI, measure again

On an internal admin screen with a tree of ~100 items, clicking one checkbox re-rendered every row. The report showed a high `startedRenders` count and flagged `changedProps.newCallback` as the repeated cause. AI read the report, proposed wrapping rows in `memo` and keeping callback and object references stable, and after the fix the same scenario was measured again (dev build).

| | Before | After |
|---|---|---|
| Render + commit per checkbox click (average) | 15.8 ms | 7.4 ms |

Measurement sequence: `window.__RDX__.reset()` → click the checkbox → `window.__RDX__.snapshot('before')` / `snapshot('after')` (or use the panel's **Save** button next to Compare). See the [Working with AI agents](#working-with-ai-agents) section below for the full workflow.

### Duplicate requests on the first screen of an existing large app

Attaching RDX to an existing service (React 18 + Vite, legacy `fetch` mixed with React Query), the very first screen showed two duplicate-request causes right away: one because an effect dependency changed (a callback built from a value that arrived late), and one because a parent's loading branch caused a child to remount, firing its mount-effect request twice. RDX works on existing code from day one — it is not only for new projects.

## Working with AI agents

Export the RDX report for AI to read, and AI will run the measure → diagnose → fix → re-measure loop for you. Use these three steps in the browser console or an AI tool:

```js
window.__RDX__.reset();                  // clear records and start a fresh measurement
// … interact with the screen …
await window.__RDX__.snapshot('before'); // save to .rdx/before.json
```

If you use Claude Code, copy the [`rdx-perf`](./skills/rdx-perf/SKILL.md) skill from the package. It runs the above sequence automatically when you ask "this screen is slow" or similar. For full details, see [Working with AI agents](./docs/ai.md).

## Docs

- [UI tour](./docs/guide.md): Boxes, Pick element, Network, Renders, React Query cache audit, panel tips
- [Working with AI agents](./docs/ai.md): `window.__RDX__`, `.rdx/report.json` report, Claude Code skill

## Good to know

- Records stay in the browser and your dev server only — nothing is sent anywhere else.
- Only JSON responses are linked to screen elements. Data from Next.js Server Components or Server Actions appears in the request list but is not traced to elements. Data the browser fetches with `fetch` (search, React Query, etc.) is traced even in the same app. WebSocket, SSE, and Service Worker requests are not captured.
- If a response is transformed with `map` or similar before being put into state, RDX cannot match the same object, so it attributes a state change that happens right after a response to that response. An unrelated render that coincides may be attached.
- Caller code file locations are shown only with dev servers that serve files individually, like Vite. With webpack or Turbopack, search by function name instead.
- The JSX location that caused a render is available only in dev builds. In React 19, the dev server transforms source and then maps lines back via source maps, so the transformed line may appear briefly before the source map arrives.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the dev setup and rules.

## License

[MIT](./LICENSE)
