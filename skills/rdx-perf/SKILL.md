---
name: rdx-perf
description: Use react-data-xray (rdx) to measure wasted requests and avoidable renders on a React page, trace root causes in code, fix them, and re-measure to compare before and after. Use this skill when the user says things like "this screen is slow", "too many requests", "too many re-renders", "fix from the rdx report", "duplicate API calls", "React Query cache key check", "reduce polling", "performance audit", or the Korean equivalents "이 화면 느려", "요청이 너무 많이 나가", "렌더가 너무 잦아", "rdx 보고서 보고 고쳐 줘", "API 중복 호출", "폴링 줄여 줘". If rdx is not installed in the app, explain how to add it first.
---

# Fix page performance with rdx

AI-generated pages often ship without verifying actual render and request costs. This skill uses rdx evidence to run one full loop: **measure → diagnose → fix → re-measure**. The report is only a starting point. Fix only what you can confirm in code.

## 1. Check setup

1. Verify that the app entry file has `import { RdxDevtools } from 'react-data-xray'` and `<RdxDevtools />` (it must be imported before react-dom).
2. Check whether the report plugin is attached to the dev server.
   - Vite: `rdx()` in `plugins` (`import { rdx } from 'react-data-xray/vite'`)
   - webpack: `rdxReportMiddleware()` in `devServer.setupMiddlewares` (`react-data-xray/middleware`)
3. If either is missing, explain how to add it and stop. Do not modify the user's build config without permission.
4. Two ways to read the report:
   - File: the plugin writes `.rdx/report.json` every 5s (relative to the directory where the dev command runs).
   - Browser tool: `window.__RDX__.report()`

## 2. Measure

Start each scenario from a clean state. Use the browser tool directly if available; otherwise ask the user to run each step.

1. Open the page to fix.
2. Run `window.__RDX__.reset()` to clear records and render stats. Without a browser tool, ask the user to open the page in a new tab (same-tab reload keeps pre-reload records).
3. Run the scenario:
   - Idle for 30s: checks for polling, periodic renders, or the page rendering on its own (do not exceed 2 min).
   - The problematic interaction: filter change, tab switch, scroll, etc.
4. Save: `await window.__RDX__.snapshot('before-<scenario>')` → creates `.rdx/before-<scenario>.json`. If the plugin is unavailable or rejected, read `report()` directly. Without a browser tool, wait 5s then copy `.rdx/report.json` under that name.
5. If `renders.monitoring` is false, render data is empty (first `report()` call without a reset). Measure once more.
6. `renders.windowSeconds` shows how much of the window was captured. Without a reset, it is the last 10s only — always reset before a measurement you will compare. After reset, data beyond 2 min is dropped. If `requests.dropped` is greater than 0, split the scenario into shorter runs.

## 3. Read the results

The `howToRead` field in the report is authoritative. This document does not duplicate it (fields grow with each rdx version), so read it before reading the results. Only the order of inspection is prescribed here.

1. `requests.endpoints`: highest waste first. `ignored: true` means the user marked it as intentional — skip it.
2. `reactQuery.findings`: follow each item's `fix`.
3. `renders.components`: most avoidable renders first. The component to fix is usually the ancestor in `causedBy`, not the component itself.

## 4. Confirm the root cause (required before fixing)

- Open code using the function name from `callers` and the `causedBy` / `renderedAt` paths. Lines that remain as http addresses have no source map — find them by function name.
- Verify the diagnosis against the code. Example: "cards off-screen are still polling" is wrong if LazyLoad unmounts off-screen cards.
- If unsure, do not fix. Ask the user with the evidence.

## 5. Prescriptions

| Finding | Fix |
|---|---|
| Duplicate requests (two components send the same request) | Fetch once in a common ancestor; move to React Query for cache sharing |
| Same-response refetch + renders caused by it (`fromSameResponse`) | Skip `setState` when the response is unchanged; use React Query structural sharing; increase `staleTime` |
| Polling running in hidden tab or off-screen | Pause polling on `document.hidden` or when the component is off-screen (`refetchInterval` condition) |
| Parent render causes child (`causedBy` is an ancestor) | Fix the unnecessary `setState` in the ancestor first, then consider `React.memo` |
| Same content, new reference (`changedProps.sameContent`) | `useMemo` in the parent; use structural sharing for responses |
| New callback (`changedProps.newCallback`) | `useCallback` in the parent |
| Context change | Split frequently-changing and stable values into separate contexts; `useMemo` for Provider value |
| React Query key problem | Follow `reactQuery.findings[].fix` |

## 6. Constraints

- Do not change behavior. Example: `setSummary({ ...data, before: summary })` uses the previous value — skipping `setState` on same responses would break the delta display. Check all usages first.
- Fix one root cause at a time, then re-measure. Fixing several at once makes it impossible to know which one helped.
- Follow the test and lint rules of the target repository (AGENTS.md, CLAUDE.md, etc.).

## 7. Re-measure and report

1. Run the same scenario again following the same steps as section 2, then save with `snapshot('after-<scenario>')`.
2. Compare before and after: `count` · `duplicates` · `sameResponses` per endpoint; `renders` · `avoidable` per component.
3. If a metric did not improve, revert that change.
4. Report to the user in a table: what was fixed and why (code location), before/after numbers, and anything that could not be confirmed.

## Notes

- Render data is only accurate in a dev build (React 18's `_debugSource` is required for `renderedAt`).
- rdx creates `.rdx/.gitignore` automatically so the directory is not committed.
- Response bodies and headers are not included in the report. URL query strings are.
