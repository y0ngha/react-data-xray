# react-data-xray

## 이슈 먼저

문제는 이슈를 만든 뒤에 고친다. 이슈는 맥락 보존 장치다. 코드와 커밋은 무엇을 바꿨는지만 남기고, 나중에 같은 코드를 고칠 사람이
왜 그렇게 고쳤는지 찾을 곳은 이슈다.

1. `.github/ISSUE_TEMPLATE/` 의 템플릿(버그, 기능·개선, 작업) 하나로 이슈를 만든다: `gh issue create --template "버그"`.
   "왜"와 "맥락" 절은 검토한 대안과 하지 않기로 한 것까지 채운다.
2. 브랜치에서 고친다. 고치다 원인이나 범위가 바뀌면 그 사실을 이슈에 먼저 적는다.
3. PR 은 `.github/pull_request_template.md` 로 연다. 본문의 `Closes #<번호>`(버그는 `Fixes #<번호>`)로 이슈를 닫는다.
   CI 의 `pr-body` 검사가 템플릿 표식과 이 줄을 확인한다.

완료 조건: PR 이 닫는 이슈가 있고, 그 이슈만 읽어도 왜 고쳤는지와 어떤 맥락에서 그 방법을 골랐는지 알 수 있다.

## 코드

- rdx 는 앱 경로(React commit, fetch/XHR, `res.json()`, `JSON.parse`)에서 참조만 담고, 분석은 `src/core/scheduler/idleQueue.ts`
  의 큐에서 조각으로 한다. 큐는 사용자 조회(요소 클릭, 요청 상세, 보고서)에서만 비운다.
- 린트 경고는 코드를 고쳐 없앤다. React 의 dev 필드처럼 바꿀 수 없는 이름은 `.oxlintrc.json` 의 허용 목록에 넣는다.
- 명령과 규칙은 [CONTRIBUTING.md](./CONTRIBUTING.md), 설계 판단은 [docs/CONTEXT.md](./docs/CONTEXT.md).
