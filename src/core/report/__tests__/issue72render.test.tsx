import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type FC } from 'react';
import { afterEach, expect, it } from 'vitest';

import { resetRenderStats, setRenderMonitoring } from '../../render/monitor.js';
import { buildReport, buildSnapshotReport } from '../buildReport.js';
import { compare, toComparable } from '../compare.js';
import { MAX_RENDER_GROUPS } from '../renderSection.js';

afterEach(() => {
  cleanup();
  resetRenderStats();
  setRenderMonitoring(false);
});

// 부모가 렌더할 때마다 같은 props 로 따라 렌더되는(줄일 수 있는) 서로 다른 이름의 자식들
const children: FC[] = Array.from({ length: MAX_RENDER_GROUPS + 5 }, (_, i) => {
  const Child: FC = () => <i>{i}</i>;
  Child.displayName = `Child${i}`;
  return Child;
});

const Page = () => {
  const [n, setN] = useState(0);
  return (
    <div>
      <button onClick={() => setN((v) => v + 1)}>bump</button>
      <span>{n}</span>
      {children.map((C) => (
        <C key={C.displayName} />
      ))}
    </div>
  );
};

const bump = (label: string, times: number) => {
  for (let i = 0; i < times; i++) act(() => fireEvent.click(screen.getByText(label)));
};

it('real_report: 보고서 상한 밖 행도 비교용 부분에 남아, 순위가 밀린 컴포넌트를 removed 로 보지 않는다 (#72)', () => {
  setRenderMonitoring(true);
  render(<Page />);
  bump('bump', 2);
  const { report, renderBeyondCap } = buildSnapshotReport(true);
  expect(report.renders.components).toHaveLength(MAX_RENDER_GROUPS);
  expect(report.renders.omitted.components).toBeGreaterThan(0);
  expect(renderBeyondCap).toHaveLength(report.renders.omitted.components);
  const before = toComparable(report, renderBeyondCap);
  // 상한 밖 행을 다 담아 남은 것이 없다.
  expect(before.renders.omitted).toMatchObject({ components: 0, renders: 0, avoidable: 0 });
  expect(before.renders.components.length).toBe(report.renders.components.length + report.renders.omitted.components);

  // 같은 측정을 보고서 JSON 으로만 가진 경우(파일): 상한 밖 행을 모르므로 한쪽에만 보이는 행은 unknown 이다.
  const fromFile = toComparable(JSON.parse(JSON.stringify(report)));
  expect(fromFile.renders.omitted).toEqual(report.renders.omitted);
  const missing = before.renders.components.find((c) => !fromFile.renders.components.some((f) => f.name === c.name))!;
  const vsFile = compare(fromFile, before);
  expect(vsFile.renders.find((r) => r.name === missing.name)).toMatchObject({ status: 'unknown', verdict: 'unknown' });
  expect(vsFile.renders.some((r) => r.status === 'removed' || r.status === 'added')).toBe(false);
  expect(vsFile.totals.renders.verdict).toBe('unchanged');

  // 두 탭 보고서끼리는 모든 행을 보므로 같은 측정이면 증감이 없다.
  const again = buildSnapshotReport(true);
  expect(compare(before, toComparable(again.report, again.renderBeyondCap)).renders).toEqual([]);
  // 보통 보고서(주기 업로드·report())는 상한 밖 행을 만들지 않고, 그것만으로 비교하면 빠진 행은 unknown 이다.
  expect(compare(before, toComparable(buildReport(true))).renders.every((r) => r.status === 'unknown')).toBe(true);
  expect(JSON.stringify(report)).not.toContain(`"name":"${missing.name}"`);
});
