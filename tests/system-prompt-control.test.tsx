import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SystemPromptControl } from '@/components/system-prompt-control';

const defaultProps = {
  useSystemPrompt: true,
  useSelectorSystemPrompt: false,
  value: 'Ты преподаватель.',
  hasInvalidCustomSystemPrompt: false,
  isGenerating: false,
  onUseSystemPromptChange: vi.fn(),
  onUseSelectorSystemPromptChange: vi.fn(),
  onValueChange: vi.fn(),
};

describe('включение системного промпта', () => {
  it('скрывает поле, источник и ошибки при выключении', () => {
    const markup = renderToStaticMarkup(
      <SystemPromptControl
        {...defaultProps}
        useSystemPrompt={false}
        hasInvalidCustomSystemPrompt
      />,
    );

    expect(markup).toContain('Использовать системный промпт');
    expect(markup).toContain('id="use-system-prompt"');
    expect(markup).not.toContain('<textarea');
    expect(markup).not.toContain('id="use-selector-system-prompt"');
    expect(markup).not.toContain('id="system-prompt-error"');
    expect(markup).not.toContain(defaultProps.value);
    expect(markup).toContain(
      'Дополнительный системный промпт не отправляется.',
    );
    expect(markup).toContain('долговременная память не пуста');
  });

  it('возвращает прежнее содержимое после включения', () => {
    for (const useSystemPrompt of [true, false, true]) {
      const markup = renderToStaticMarkup(
        <SystemPromptControl
          {...defaultProps}
          useSystemPrompt={useSystemPrompt}
        />,
      );

      expect(markup.includes(defaultProps.value)).toBe(useSystemPrompt);
      expect(markup.includes('id="system-prompt"')).toBe(useSystemPrompt);
    }
    expect(defaultProps.onValueChange).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'сохраняет режим из селекторов: %s',
    (useSelectorSystemPrompt) => {
      const markup = renderToStaticMarkup(
        <SystemPromptControl
          {...defaultProps}
          useSelectorSystemPrompt={useSelectorSystemPrompt}
        />,
      );
      const textarea = markup.match(/<textarea\b[^>]*>/)?.[0];

      expect(textarea).toContain('aria-label="Системный промпт"');
      expect(textarea?.includes('readOnly=""')).toBe(useSelectorSystemPrompt);
      expect(markup).toContain('id="use-selector-system-prompt"');
    },
  );

  it('блокирует переключатели во время генерации', () => {
    const markup = renderToStaticMarkup(
      <SystemPromptControl {...defaultProps} isGenerating />,
    );
    const checkboxes = markup.match(/<span\b[^>]*role="checkbox"[^>]*>/g) ?? [];

    expect(checkboxes).toHaveLength(2);
    for (const checkbox of checkboxes)
      expect(checkbox).toContain('aria-disabled="true"');
    expect(markup.match(/<textarea\b[^>]*>/)?.[0]).toContain('readOnly=""');
  });
});
