// 순서가 중요하다: 렌더 감시는 react-dom 보다 먼저 평가돼야 React 의 commit 을 받을 수 있다.
import { ignoreComponent } from './core/render/monitor.js';
import { configure as configureDev, type RdxConfig } from './core/config.js';
import { installCapture } from './core/capture/install.js';
import { scheduleLoadOrderCheck } from './core/diagnostics/loadOrder.js';
import { installUnusedCheck } from './core/inspect/unused.js';
import { installReportApi } from './core/report/reportApi.js';
import { installSessionRecords } from './core/requests/sessionRecords.js';
import type { RdxDevtoolsProps } from './ui/RdxDevtools.js';
import { SafeRdxDevtools as Devtools } from './ui/SafeRdxDevtools.js';

export type { RdxDevtoolsProps } from './ui/RdxDevtools.js';
export type { RdxConfig } from './core/config.js';

// 같은 페이지에 rdx 가 두 벌 평가됐는지(모노레포에서 경로가 둘로 갈리는 등) 보는 표식. 모듈 상태가 따로라 각 설치 함수의 가드로는 막지 못한다.
const INSTALLED = Symbol.for('react-data-xray.installed');

/** 처음 평가된 rdx 만 true. 두 번째부터는 fetch 를 두 겹으로 감싸지 않게 설치를 건너뛰고 한 번 경고한다. */
const claimInstall = (): boolean => {
  const g = globalThis as { [INSTALLED]?: 'installed' | 'warned' };
  if (!g[INSTALLED]) {
    g[INSTALLED] = 'installed';
    return true;
  }
  if (g[INSTALLED] === 'installed') {
    g[INSTALLED] = 'warned';
    console.warn(
      '[react-data-xray] Two copies of react-data-xray were loaded on this page; only the first one is active. ' +
        'Make every package resolve the same copy (e.g. dedupe it with your package manager, or resolve.dedupe in Vite).',
    );
  }
  return false;
};

// 모듈 최상위에서 설치하는 파일은 package.json 의 sideEffects 에 둔다. 빠지면 단독 import 를 번들러가 지운다(#61).
// 조건을 변수에 담지 않고 직접 쓴다. 그래야 webpack 도 production 에서 dev 분기를 상수로 접어 패널 코드를 지운다.
if (process.env.NODE_ENV !== 'production' && claimInstall()) {
  // 새로고침 전 요청 기록을 앱 요청보다 먼저 되살린다(같은 탭 안에서만).
  installSessionRecords();
  // 컴포넌트 mount 보다 먼저 요청이 나가므로(자식 effect 가 먼저 돈다) import 시점에 설치한다.
  installCapture();
  // AI 가 결과를 읽는 창구: window.__RDX__.report(), dev 서버 플러그인이 있으면 .rdx/report.json
  installReportApi();
  // react-dom 보다 늦게 불렀는지 잠시 뒤 유휴 큐에서 판정한다. 패널 없이 보고서만 쓰는 설정도 경고를 받는다.
  scheduleLoadOrderCheck();
  // 응답 몇 초 뒤 그 응답을 쓰는 컴포넌트가 없는지 유휴 큐에서 판정한다(#87). 패널 없이 보고서만 쓰는 설정도 판정한다.
  installUnusedCheck();
}
// 패널 자신(과 그것을 감싼 에러 바운더리)의 렌더는 렌더 감시에서 뺀다. 렌더 감시(monitor)는 사본마다 따로 돌므로 사본마다 뺀다.
if (process.env.NODE_ENV !== 'production') ignoreComponent(Devtools);

/** production 빌드에서는 아무것도 그리지 않는 빈 컴포넌트로 바뀐다. */
export const RdxDevtools: (props: RdxDevtoolsProps) => ReturnType<typeof Devtools> | null =
  process.env.NODE_ENV !== 'production' ? Devtools : () => null;

/**
 * 판정 기준과 무시 목록을 코드에서 정한다. `import 'react-data-xray'` 바로 뒤, 앱이 요청을 보내기 전에 부른다.
 * production 빌드에서는 아무것도 하지 않는다.
 */
export const configure: (options?: RdxConfig) => void = process.env.NODE_ENV !== 'production' ? configureDev : () => undefined;
