# 기여 안내

## 준비

```bash
pnpm install
pnpm check          # 타입체크 → oxlint → react-doctor → 포맷 검사 → 테스트·커버리지(80% 이상)
pnpm test           # 테스트만
pnpm fmt            # 포맷 적용
pnpm sync <앱 경로>  # 빌드해서 file: 로 연결한 앱의 node_modules 에 반영
```

## 연결한 앱에서 고치며 보기

앱에서 `pnpm add -D file:../react-data-xray` 로 연결한 뒤, rdx 를 고칠 때마다 `pnpm sync <앱 경로>` 로 반영합니다.

- **Vite 앱**: `vite.config` 에 아래 두 줄을 두면 `pnpm sync` 만으로 페이지가 새 코드로 다시 열립니다. 없으면 sync 할 때마다 dev 서버를 `--force` 로 다시 띄워야 합니다.

  ```ts
  server: { watch: { ignored: ['!**/node_modules/react-data-xray/**'] } },
  optimizeDeps: { exclude: ['react-data-xray'] },
  ```

  서버 쪽 코드(미들웨어)를 고쳐 dev 서버를 다시 띄웠다면, 띄운 **뒤에** `pnpm sync` 를 한 번 더 합니다.
- **Next.js(Turbopack)**: 청크 이름이 바뀌지 않아 이전 코드가 남습니다. sync 뒤 `.next/dev` 를 지우고 dev 서버를 다시 띄운 다음, 브라우저에서 강력 새로고침(<kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>)합니다.

## 규칙

- 테스트는 각 폴더의 `__tests__` 에 둡니다. 테스트 안에서 시나리오용 컴포넌트를 그 자리에서 정의하는 것은 의도된 패턴이라, 테스트 폴더에서만 `unicorn/consistent-function-scoping` 을 끕니다(`.oxlintrc.json`).
- 테스트 픽스처는 rdx 가 관찰할 `useEffect + fetch` 패턴을 일부러 재현하므로, react-doctor 의 `no-fetch-in-effect` 도 테스트 폴더에서만 끕니다(`doctor.config.json`).
- react-doctor 는 공급망 검사(의존성 목록을 외부로 보냄)와 사용 통계 전송을 끄고 실행합니다.
- 컴파일 대상은 ES2020 입니다. `toSorted`·`toReversed` 같은 ES2023 메서드는 폴리필 없이 오래된 브라우저에서 깨지므로 쓰지 않고, 복사한 배열에서만 `sort`·`reverse` 합니다.
- 설계와 판단 근거는 [docs/CONTEXT.md](./docs/CONTEXT.md), 앞으로 할 일은 [docs/ROADMAP.md](./docs/ROADMAP.md)에 있습니다. 기능을 고치거나 더할 때 CONTEXT.md 의 목표와 맞는지 먼저 확인합니다.
