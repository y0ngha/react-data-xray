import { describe, expect, it } from 'vitest';

import { compare, type ComparableReport } from '../compare.js';

type Row = ComparableReport['renders']['components'][number];

const row = (name: string, renderedAt: string, renders: number, avoidable = 0): Row => ({
  name,
  renderedAt,
  id: `c:${name}@${renderedAt}`,
  renders,
  avoidable,
});

// omitted 의 components 가 0 보다 크면 상한 밖 행이 있었을 수 있다(한쪽에만 있는 행은 unknown).
const side = (components: Row[], hidden = 0): ComparableReport => ({
  requests: { endpoints: [] },
  renders: { monitoring: true, windowSeconds: 20, components, omitted: { components: hidden, renders: hidden, avoidable: 0 } },
  reactQuery: { findings: [], fetchCauses: [] },
});

describe('JSX 줄만 옮긴 렌더 행 (#129)', () => {
  it('moved_row: 이름·파일이 같고 줄만 바뀐 행은 한 행으로 맞춰 판정하고, 옮기기 전 위치를 남긴다', () => {
    const before = side([row('Pill', 'src/Grid.tsx:147', 380, 10)], 12);
    const after = side([row('Pill', 'src/Grid.tsx:133', 190, 2)], 12);
    expect(compare(before, after).renders).toEqual([
      {
        name: 'Pill',
        id: 'c:Pill@src/Grid.tsx:133',
        renderedAt: 'src/Grid.tsx:133',
        renderedAtBefore: 'src/Grid.tsx:147',
        renders: -190,
        avoidable: -8,
        verdict: 'improved',
      },
    ]);
  });

  it('ambiguous_same_file: 같은 파일에 같은 이름 행이 둘 이상이면 어느 쪽이 옮겨졌는지 몰라 맞추지 않는다', () => {
    const before = side([row('Row', 'src/List.tsx:10', 5), row('Row', 'src/List.tsx:20', 5)]);
    const after = side([row('Row', 'src/List.tsx:12', 3), row('Row', 'src/List.tsx:22', 3)]);
    const rows = compare(before, after).renders;
    expect(rows.map((r) => r.status).sort()).toEqual(['added', 'added', 'removed', 'removed']);
    expect(rows.some((r) => 'renderedAtBefore' in r)).toBe(false);
  });

  it('other_file: 다른 파일의 같은 이름 행은 맞추지 않는다', () => {
    const rows = compare(side([row('Card', 'src/A.tsx:5', 4)]), side([row('Card', 'src/B.tsx:5', 4)])).renders;
    expect(rows.map((r) => [r.status, r.renderedAt])).toEqual([
      ['removed', 'src/A.tsx:5'],
      ['added', 'src/B.tsx:5'],
    ]);
  });

  it('same_id_kept: id 가 같은 행은 그대로 맞추고, 줄만 바뀐 다른 행 맞추기에 끼지 않는다', () => {
    const before = side([row('Pill', 'src/Grid.tsx:147', 10), row('Head', 'src/Grid.tsx:20', 3)]);
    const after = side([row('Pill', 'src/Grid.tsx:150', 4), row('Head', 'src/Grid.tsx:20', 1)]);
    const rows = compare(before, after).renders;
    expect(rows.find((r) => r.name === 'Head')).toMatchObject({ renders: -2, verdict: 'improved' });
    expect(rows.find((r) => r.name === 'Head')).not.toHaveProperty('renderedAtBefore');
    expect(rows.find((r) => r.name === 'Pill')).toMatchObject({ renderedAtBefore: 'src/Grid.tsx:147', renders: -6 });
  });
});
