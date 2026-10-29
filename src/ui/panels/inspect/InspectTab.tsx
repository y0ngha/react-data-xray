import type { EndpointStat } from '../../../core/requests/endpointStats.js';
import { endpointOf } from '../../../core/requests/requestKey.js';
import type { Hit, InspectResult } from '../../../core/inspect/types.js';
import { Muted } from '../../components/Muted.js';
import { color } from '../../theme.js';
import { HitRow } from './HitRow.js';

const hitKey = (hit: Hit) => `${hit.record.id}|${hit.path}|${hit.via}`;

const HitList = ({ hits, stats }: { hits: readonly Hit[]; stats: ReadonlyMap<string, EndpointStat> }) => (
  <>
    {hits.map((hit) => (
      <HitRow key={hitKey(hit)} hit={hit} stat={stats.get(endpointOf(hit.record))} />
    ))}
  </>
);

/** 데이터 › 출처: 클릭한 요소의 데이터가 어느 API 응답에서 왔는지 */
export const InspectTab = ({ result, stats }: { result: InspectResult | null; stats: ReadonlyMap<string, EndpointStat> }) => {
  if (!result) return <Muted>Use [Pick element] to select an element and see its data source and a scoped analysis.</Muted>;
  const withHits = result.components.filter((c) => c.hits.length > 0);
  return (
    <div>
      <Muted>
        {result.components
          .slice(0, 4)
          .map((c) => c.name)
          .join(' ← ')}
      </Muted>
      {withHits.map((c) => (
        <div key={c.depth} style={{ marginTop: 8 }}>
          <div style={{ color: color.heading }}>&lt;{c.name}&gt;</div>
          <HitList hits={c.hits} stats={stats} />
        </div>
      ))}
      {withHits.length === 0 && result.guesses.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <Muted>No match via component data; results are based on page text.</Muted>
          <HitList hits={result.guesses} stats={stats} />
        </div>
      )}
      {withHits.length === 0 && result.guesses.length === 0 && <Muted>No linked API response found.</Muted>}
    </div>
  );
};
