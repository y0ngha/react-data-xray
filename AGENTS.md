# react-data-xray

## 이슈 먼저

문제는 이슈를 만든 뒤에 고친다. 이슈는 맥락 보존 장치다. 코드와 커밋은 무엇을 바꿨는지만 남기고, 나중에 같은 코드를 고칠 사람이
왜 그렇게 고쳤는지 찾을 곳은 이슈다.

1. `.github/ISSUE_TEMPLATE/` 의 템플릿(`bug.md`, `feature.md`, `task.md`) 하나를 골라, 머리말(`---` 사이)을 뺀 본문을 임시 파일에
   복사해 채운다. 첫 줄의 `<!-- rdx-issue-template -->` 표식은 그대로 둔다. "왜"와 "맥락" 절은 검토한 대안과 하지 않기로 한 것까지 쓴다.
2. 머리말의 제목 머리와 라벨로 이슈를 만든다: `gh issue create --title "[버그] …" --label bug --body-file <파일>`.
3. 브랜치에서 고친다. 고치다 원인이나 범위가 바뀌면 그 사실을 이슈에 먼저 적는다.
4. `.github/pull_request_template.md` 를 임시 파일에 복사해 채우고 `gh pr create --title "…" --body-file <파일>` 로 연다.
   `Closes #<이슈 번호>` 줄과 첫 줄의 `<!-- rdx-pr-template -->` 표식은 그대로 둔다.

완료 조건: `gh pr view --json closingIssuesReferences` 에 그 이슈가 있고, CI 의 `pr-body` 검사가 통과한다(이슈가 열려 있고 이슈 템플릿
표식이 있는지까지 본다).

## 코드

- rdx 는 앱 경로(React commit, fetch/XHR, `res.json()`, `JSON.parse`)에서 참조만 담고, 분석은 유휴 큐(`src/core/scheduler/idleQueue.ts`)
  에서 조각으로 한다. 큐를 그 자리에서 비우는 곳은 사용자 조회(요소 클릭, 요청 상세, 요청 행 마우스 강조, 보고서)와 페이지를 떠날 때
  기록 저장, 보고서 저장 전 소스맵 대기뿐이다. 주기적으로 도는 화면은 그때까지 분석된 것만 보여 준다.
- 린트 경고는 코드를 고쳐 없앤다. React 의 dev 필드처럼 바꿀 수 없는 이름은 `.oxlintrc.json` 의 허용 목록에 넣는다.
- 명령과 규칙은 [CONTRIBUTING.md](./CONTRIBUTING.md), 설계 판단은 [docs/CONTEXT.md](./docs/CONTEXT.md).
