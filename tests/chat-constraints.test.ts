import { describe, expect, it } from 'vitest';

import {
  calculateMaxOutputTokens,
  calculateTargetOutputRange,
  estimateContextTokenCount,
  estimateTokenCount,
  isValidContextWindowTokens,
  isValidModel,
  isValidTargetOutputTokens,
  isValidTargetOutputTokensOrNull,
  isValidTemperature,
  MAX_MAX_OUTPUT_TOKENS,
  MAX_CONTEXT_WINDOW_TOKENS,
  MAX_MODEL_ID_LENGTH,
  MIN_CONTEXT_WINDOW_TOKENS,
} from '@/lib/chat-constraints';

describe('ограничения длины ответа', () => {
  it.each([
    [50, 550],
    [500, 1000],
    [2500, 3000],
    [8000, 9600],
    [10_000, 12_000],
    [20_000, 22_000],
    [98_000, 100_000],
  ])('рассчитывает максимум для цели %s как %s', (target, expectedMax) => {
    expect(calculateMaxOutputTokens(target)).toBe(expectedMax);
  });

  it.each([50, 500, 8000, 98_000])('принимает допустимую цель %s', (target) => {
    expect(isValidTargetOutputTokens(target)).toBe(true);
  });

  it.each([49, 98_001, 100.5, Number.NaN])(
    'отклоняет недопустимую цель %s',
    (target) => {
      expect(isValidTargetOutputTokens(target)).toBe(false);
    },
  );

  it.each([
    [300, { min: 262, max: 338 }],
    [8000, { min: 7000, max: 9000 }],
    [20_000, { min: 17_500, max: 22_000 }],
    [98_000, { min: 85_750, max: 100_000 }],
  ])(
    'ограничивает диапазон цели %s техническим максимумом',
    (target, expectedRange) => {
      expect(calculateTargetOutputRange(target)).toEqual(expectedRange);
    },
  );

  it('отключённая цель (null) не ограничивает максимум ответа техническим потолком API', () => {
    expect(calculateMaxOutputTokens(null)).toBe(MAX_MAX_OUTPUT_TOKENS);
  });

  it('null — допустимое значение цели (означает "без ограничения")', () => {
    expect(isValidTargetOutputTokensOrNull(null)).toBe(true);
  });

  it.each([50, 500, 8000, 98_000])(
    'принимает допустимое числовое значение цели %s',
    (target) => {
      expect(isValidTargetOutputTokensOrNull(target)).toBe(true);
    },
  );

  it.each([49, 98_001, 100.5, Number.NaN, undefined, '500', {}, []])(
    'отклоняет недопустимое значение цели %j (кроме null)',
    (target) => {
      expect(isValidTargetOutputTokensOrNull(target)).toBe(false);
    },
  );
});

describe('температура', () => {
  it.each([0, 0.1, 0.25, 1, 1.9, 2])('принимает %s', (value) => {
    expect(isValidTemperature(value)).toBe(true);
  });

  it.each([
    -0.1,
    2.1,
    NaN,
    Infinity,
    -Infinity,
    '1',
    '',
    null,
    undefined,
    true,
    {},
    [],
  ])('отклоняет %j', (value) => {
    expect(isValidTemperature(value)).toBe(false);
  });
});

describe('модель', () => {
  it.each([
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'a',
    'x'.repeat(MAX_MODEL_ID_LENGTH),
  ])('принимает %s', (value) => {
    expect(isValidModel(value)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'x'.repeat(MAX_MODEL_ID_LENGTH + 1),
    123,
    null,
    undefined,
    true,
    {},
    [],
  ])('отклоняет %j', (value) => {
    expect(isValidModel(value)).toBe(false);
  });
});

describe('оценка числа токенов', () => {
  it('возвращает 0 для пустого или пробельного текста', () => {
    expect(estimateTokenCount('')).toBe(0);
    expect(estimateTokenCount('   ')).toBe(0);
  });

  it('округляет вверх и не опускается ниже 1 для непустого текста', () => {
    expect(estimateTokenCount('a')).toBe(1);
    expect(estimateTokenCount('Привет')).toBe(3);
    expect(estimateTokenCount('x'.repeat(400))).toBe(100);
    expect(estimateTokenCount('x'.repeat(401))).toBe(101);
  });

  it('учитывает UTF-8-размер Unicode-текста', () => {
    expect(estimateTokenCount('т'.repeat(100))).toBe(50);
    expect(estimateTokenCount('a'.repeat(100))).toBe(25);
  });

  it('игнорирует ведущие и хвостовые пробелы', () => {
    expect(estimateTokenCount('  привет  ')).toBe(estimateTokenCount('привет'));
  });

  it('оценивает полный контекст вместе с ролями, системным промптом и изображениями', () => {
    expect(
      estimateContextTokenCount(
        [
          { role: 'user', content: 'x'.repeat(40) },
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'y'.repeat(20) },
              { type: 'input_image', file_id: 'file-api-image-1' },
            ],
          },
        ],
        'z'.repeat(12),
      ),
    ).toBe(1052);
  });
});

describe('искусственный лимит контекста', () => {
  it.each([MIN_CONTEXT_WINDOW_TOKENS, 2000, MAX_CONTEXT_WINDOW_TOKENS])(
    'принимает допустимый лимит %s',
    (value) => {
      expect(isValidContextWindowTokens(value)).toBe(true);
    },
  );

  it.each([
    MIN_CONTEXT_WINDOW_TOKENS - 1,
    MAX_CONTEXT_WINDOW_TOKENS + 1,
    100.5,
    Number.NaN,
    '2000',
  ])('отклоняет недопустимый лимит %s', (value) => {
    expect(isValidContextWindowTokens(value)).toBe(false);
  });
});
