import { describe, expect, it } from 'vitest';

import {
  calculateMaxOutputTokens,
  calculateTargetOutputRange,
  isValidTargetOutputTokens,
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
});
