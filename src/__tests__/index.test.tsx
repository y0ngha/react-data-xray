import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('진입점', () => {
  it('개발 환경에서는 패널 버튼을 그린다', async () => {
    const { RdxDevtools } = await import('../index.js');
    const { getByRole } = render(<RdxDevtools />);
    expect(getByRole('button', { name: 'React Data X-ray 열기' })).toBeTruthy();
  });

  it('production 에서는 아무것도 그리지 않는다', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { RdxDevtools } = await import('../index.js');
    const { container } = render(<RdxDevtools />);
    expect(container.innerHTML).toBe('');
    expect(document.querySelector('[data-rdx-root]')).toBeNull();
  });
});
