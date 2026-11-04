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
    expect(getByRole('button', { name: /Open React Data X-ray/ })).toBeTruthy();
  });

  it('production 에서는 아무것도 그리지 않는다', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { RdxDevtools } = await import('../index.js');
    const { container } = render(<RdxDevtools />);
    expect(container.innerHTML).toBe('');
    expect(document.querySelector('[data-rdx-root]')).toBeNull();
  });

  it('configure 는 개발 환경에서 판정 기준을 바꾸고, production 에서는 아무것도 하지 않는다', async () => {
    const dev = await import('../index.js');
    const config = await import('../core/config.js');
    dev.configure({ maxRecords: 10 });
    expect(config.effectiveConfig().maxRecords).toBe(10);
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    const prod = await import('../index.js');
    const prodConfig = await import('../core/config.js');
    prod.configure({ maxRecords: 10 });
    expect(prodConfig.effectiveConfig().maxRecords).toBe(200);
  });
});
