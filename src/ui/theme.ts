import type { CSSProperties } from 'react';

import { isWaste, needsReview, type RequestClass } from '../core/requests/classify.js';
import type { MatchKind } from '../core/inspect/types.js';

/** 페이지 위 어떤 요소보다 위에 그린다. 오버레이는 패널보다 아래. */
export const Z_PANEL = 2147483647;
export const Z_HIGHLIGHT = Z_PANEL - 1;
export const Z_OVERLAY = Z_PANEL - 2;

export const color = {
  bg: '#111',
  panel: '#1a1a1a',
  border: '#333',
  text: '#eee',
  muted: '#9ca3af',
  heading: '#93c5fd',
  accent: '#3b82f6',
  exact: '#4ade80',
  derived: '#60a5fa',
  guess: '#facc15',
  warn: '#f87171',
  review: '#fbbf24',
  failed: '#fb923c',
  consumer: '#fb923c',
  render: '#a78bfa',
} as const;

export const FONT = '12px/1.5 ui-monospace, Menlo, monospace';
export const SMALL_FONT = '10px/1.4 ui-monospace, Menlo, monospace';

export const MATCH_LABEL: Record<MatchKind, string> = { exact: 'exact', derived: 'derived', text: 'guessed' };
export const MATCH_COLOR: Record<MatchKind, string> = { exact: color.exact, derived: color.derived, text: color.guess };

/** 낭비는 빨강, 확인 필요는 노랑, 정상은 회색 */
export const classColor = (c: RequestClass): string => (isWaste(c) ? color.warn : needsReview(c) ? color.review : color.muted);

// 앱의 전역 CSS(pre, summary 색 등)가 패널에 새어 들지 않도록 색을 직접 지정한다.
export const codeBlockStyle: CSSProperties = {
  color: color.text,
  margin: '4px 0',
  padding: 6,
  maxHeight: 280,
  overflow: 'auto',
  background: color.panel,
  borderRadius: 4,
  whiteSpace: 'pre-wrap',
  font: 'inherit',
};

export const rowStyle: CSSProperties = { padding: '4px 0', borderTop: `1px solid ${color.border}` };
export const mutedStyle: CSSProperties = { color: color.muted };

/** 버튼 기본 모양을 지우고 글자처럼 보이게 한다(목록 행을 버튼으로 만들 때). */
export const plainButtonStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  padding: 0,
  border: 0,
  background: 'none',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
};
