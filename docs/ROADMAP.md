# react-data-xray 로드맵

목표와 방법은 [CONTEXT.md](./CONTEXT.md)에 있습니다. 여기서는 아직 하지 않은 일을 우선순위대로 적습니다.

## 다음에 할 일

적합성 평가(목표 5개 기준)에서 "한눈에 보이는가"를 기준으로 뽑은 일은 모두 끝냈습니다. 남은 일은 "그다음" 과 배포 준비입니다.

끝낸 것:
- rdx 와 함께 쓰는 AI 스킬(`skills/rdx-perf`, 패키지에 포함). haiku·sonnet·opus 에게 같은 rdx 출력을 주고 진단시킨 감사(2026-10-27)에서 세 모델이 공통으로 꼽은 부족한 정보를 먼저 채웠습니다: 소스맵을 적용한 호출 위치, 렌더를 시작한 조상과 그리는 JSX 위치, 호출 위치별 집계, 같은 응답으로 일어난 렌더 수, 이름 붙인 보고서 저장(`window.__RDX__.snapshot`)과 측정 초기화(`reset`).
- 대상(화면 전체·요소 선택)과 관점(데이터·네트워크·렌더) 분리, 박스 토글
- 박스 라벨 지표(×6 · 중복 2 · 같은 응답 3), RDX 버튼의 문제 수와 깜빡임
- 필드 수준 출처, context 로 받은 데이터의 출처
- React Query 캐시키 점검(중복 캐시·키에 빠진 파라미터·빗나간 무효화·staleTime 0)
- 탭 단위 상태·요청 기록 유지, AI 용 보고서(`.rdx/report.json`, `window.__RDX__`)
- 낭비 경고 잡음 줄이기(포커스·재연결·StrictMode 포함), 리렌더 시각화, 요청을 보낸 코드 위치, 렌더 이유 분석(context·새 콜백 포함), 요청 ↔ 컴포넌트 ↔ 렌더 연결(CONTEXT 4장, 5장)

## 그다음

- **헤더 비교**: 헤더만 다른 요청을 구분하는 옵션
- **설정**: 중복 판정 시간(2초), 몰림 기준(500ms·5건), 기억할 요청 수(200건)를 props로 조절
- **내보내기**: 보고서(`.rdx/report.json`)는 생겼습니다. 패널에서 버튼 한 번으로 받아 이슈나 PR 에 첨부하는 기능은 아직입니다.
- **WebSocket, SSE**: 스트리밍 데이터의 출처 표시

## 배포 전 확인 사항

아직 확인하지 않은 환경입니다. 배포 전에 하나씩 확인하고 결과를 여기에 적습니다.

- [ ] **React 19**: fiber 구조(`dependencies.firstContext`, 훅 체인, `PerformedWork` 플래그), StrictMode 재실행 함수 이름, `__REACT_DEVTOOLS_GLOBAL_HOOK__` 등록 시점이 18과 같은지. React 19 는 `_debugSource` 를 없앴으므로 소스 위치가 필요한 기능은 `_debugStack` 으로 확인
- [ ] **webpack production 빌드**: `process.env.NODE_ENV === 'production'` 분기가 접혀 패널 코드가 번들에서 빠지는지(번들 크기, `react-data-xray` 문자열 검색)
- [ ] **webpack·Next.js dev**: import 순서(react-dom 보다 먼저)가 지켜지는지, 호출 스택 필터가 webpack 의 모듈 경로에서도 rdx 프레임만 빼는지
- [ ] **Vite production 빌드**: rolldown 으로는 확인함(dsi 시절, 41바이트). 리팩터링 뒤 다시 확인
- [ ] **오래된 브라우저**: 컴파일 대상(ES2020)에 맞는지

## 배포

- npm 공개 배포 여부 결정, README 사용법 보강
- React 18, 19와 주요 번들러(Vite, webpack, Next.js)에서 동작 확인
- production 빌드에서 코드가 빠지는지(tree-shaking) 확인
