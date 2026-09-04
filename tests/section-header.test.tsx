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

  it('без списка моделей остаётся статичным бейджем', () => {
    const markup = renderToStaticMarkup(
      <SectionHeader
        title="Сравнение"
        subtitle="сравнение ответов"
        clearLabel="Очистить сравнение"
      />,
    );

    expect(markup).toContain('V4 Flash');
    expect(markup).not.toContain('data-slot="select-trigger"');
    expect(markup).not.toContain('aria-label="Модель"');
  });

  it('с пустым списком моделей остаётся статичным бейджем', () => {
    const markup = renderToStaticMarkup(
      <SectionHeader
        title="Чат"
        subtitle="Локальный AI-диалог"
        clearLabel="Очистить диалог"
        model="deepseek-v4-flash"
        availableModels={[]}
        onModelChange={vi.fn()}
      />,
    );

    expect(markup).toContain('V4 Flash');
    expect(markup).not.toContain('data-slot="select-trigger"');
  });

  it('становится выбором модели, когда список доступен', () => {
    const onModelChange = vi.fn();
    const markup = renderToStaticMarkup(
      <SectionHeader
        title="Чат"
        subtitle="Локальный AI-диалог"
        clearLabel="Очистить диалог"
        model="deepseek-v4-pro"
        availableModels={['deepseek-v4-flash', 'deepseek-v4-pro']}
        onModelChange={onModelChange}
      />,
    );

    expect(markup).toContain('data-slot="select-trigger"');
    expect(markup).toContain('aria-label="Модель"');
    expect(markup).toContain('V4 Pro');
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('форматирует известные идентификаторы моделей коротко', () => {
    const markup = renderToStaticMarkup(
      <SectionHeader
        title="Чат"
        subtitle="Локальный AI-диалог"
        clearLabel="Очистить диалог"
        model="deepseek-reasoner"
        availableModels={['deepseek-reasoner']}
        onModelChange={vi.fn()}
      />,
    );

    expect(markup).toContain('Reasoner');
  });

  it('блокирует выбор модели во время генерации, не трогая кнопку очистки', () => {
    const onClear = vi.fn();
    const markup = renderToStaticMarkup(
      <SectionHeader
        title="Чат"
        subtitle="Локальный AI-диалог"
        clearLabel="Очистить диалог"
        canClear
        onClear={onClear}
        model="deepseek-v4-flash"
        availableModels={['deepseek-v4-flash']}
        onModelChange={vi.fn()}
        modelDisabled
      />,
    );

    const modelTrigger = markup.match(
      /<button\b[^>]*data-slot="select-trigger"[^>]*>/,
    )?.[0];
    const clearButton = markup.match(
      /<button\b[^>]*aria-label="Очистить диалог"[^>]*>/,
    )?.[0];

    expect(modelTrigger).toContain('disabled=""');
    expect(clearButton).toBeDefined();
    expect(clearButton).not.toContain('disabled=""');
  });

  it('передаёт причину недоступного списка моделей в подсказку', () => {
    const markup = renderToStaticMarkup(
      <SectionHeader
        title="Чат"
        subtitle="Локальный AI-диалог"
        clearLabel="Очистить диалог"
        model="deepseek-v4-flash"
        availableModels={['deepseek-v4-flash']}
        onModelChange={vi.fn()}
        modelsError="Не удалось загрузить список моделей."
      />,
    );

    expect(markup).toContain('title="Не удалось загрузить список моделей."');
  });
});
