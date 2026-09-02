import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Comparison } from '@/components/comparison';
import {
  comparisonHistory,
  COMPARISON_VARIANTS,
  type ComparisonTurn,
} from '@/lib/comparison';

describe('сравнение', () => {
  it('показывает общий промпт и пять колонок с точными системными промптами', () => {
    const markup = renderToStaticMarkup(<Comparison />);
    expect(markup.match(/<article\b/g)).toHaveLength(5);
    expect(markup).toContain('id="comparison-user-prompt"');
    expect(markup).toContain('>Сравнить</button>');
    for (const variant of COMPARISON_VARIANTS) {
      expect(markup).toContain(`id="comparison-system-${variant.id}"`);
      if (variant.systemPrompt)
        expect(markup).toContain(`${variant.systemPrompt}</textarea>`);
    }
    expect(COMPARISON_VARIANTS.map((variant) => variant.systemPrompt)).toEqual([
      '',
      'решай пошагово',
      '',
      '',
      'Создай группу экспертов: аналитик, инженер, критик. Получи решение от каждого и одно общее',
    ]);
  });

  it('передаёт только фактический промпт и завершённое решение, без истории создания промпта', () => {
    const turns: ComparisonTurn[] = [
      {
        id: '1',
        prompt: 'Исходная задача',
        actualPrompt: 'Сгенерированный промпт',
        answer: 'Решение',
        status: 'complete',
      },
      {
        id: '2',
        prompt: 'Ошибка',
        actualPrompt: 'Ошибка',
        answer: 'Частично',
        status: 'error',
      },
      {
        id: '3',
        prompt: 'Стоп',
        actualPrompt: 'Стоп',
        answer: 'Частично',
        status: 'stopped',
      },
      { id: '4', prompt: 'Ещё задача', answer: '', status: 'preparing' },
      {
        id: '5',
        prompt: 'Пустой',
        actualPrompt: 'Пустой',
        answer: ' ',
        status: 'complete',
      },
    ];
    expect(comparisonHistory(turns)).toEqual([
      { role: 'user', content: 'Сгенерированный промпт' },
      { role: 'assistant', content: 'Решение' },
    ]);
    expect(comparisonHistory([])).toEqual([]);
  });
});
