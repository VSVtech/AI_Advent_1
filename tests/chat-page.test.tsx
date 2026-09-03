import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import Home from '@/app/page';

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

describe('настройки чата', () => {
  it('показывает температуру 1 рядом с форматом ответа', () => {
    const markup = renderToStaticMarkup(<Home />);
    const input = markup.match(/<input\b[^>]*id="temperature"[^>]*>/)?.[0];

    expect(input).toBeDefined();
    expect(input).toContain('type="number"');
    expect(input).toContain('inputMode="decimal"');
    expect(input).toContain('min="0"');
    expect(input).toContain('max="2"');
    expect(input).toContain('step="0.1"');
    expect(input).toContain('value="1"');
    expect(input).not.toContain('aria-invalid="true"');
    expect(markup).toContain('for="temperature">Температура</label>');
    expect(markup.match(/id="temperature"/g)).toHaveLength(1);

    const temperatureIndex = markup.indexOf('id="temperature"');
    const formatIndex = markup.indexOf('aria-label="Формат ответа"');
    const systemPromptIndex = markup.indexOf('id="system-prompt"');
    expect(temperatureIndex).toBeLessThan(formatIndex);
    expect(formatIndex).toBeLessThan(systemPromptIndex);
  });
});
