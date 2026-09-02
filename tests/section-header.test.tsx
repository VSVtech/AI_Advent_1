import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SectionHeader } from '@/components/section-header';

describe('общая шапка разделов', () => {
  it.each([true, false])(
    'сохраняет шапку чата и доступность очистки: %s',
    (canClear) => {
      const onClear = vi.fn();
      const markup = renderToStaticMarkup(
        <SectionHeader
          title="Чат"
          subtitle="Локальный AI-диалог"
          clearLabel="Очистить диалог"
          canClear={canClear}
          onClear={onClear}
        />,
      );

      expect(markup).toContain('>Чат</h1>');
      expect(markup).toContain('>Локальный AI-диалог</p>');
      expect(markup).toContain('V4 Flash');
      expect(markup).toContain('aria-label="Очистить диалог"');
      expect(markup.includes('disabled=""')).toBe(!canClear);
      expect(onClear).not.toHaveBeenCalled();
    },
  );
});
