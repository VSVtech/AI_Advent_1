import { describe, expect, it } from 'vitest';

import { estimateCostUsd } from '@/lib/model-pricing';

describe('оценка стоимости', () => {
  it('считает стоимость по кэшированным и некэшированным входным токенам', () => {
    // deepseek-v4-flash: 0.14 / 0.0028 / 0.28 за 1e6 токенов
    const cost = estimateCostUsd('deepseek-v4-flash', 1_000_000, 200_000, 500_000);

    const expected =
      (800_000 / 1_000_000) * 0.14 +
      (200_000 / 1_000_000) * 0.0028 +
      (500_000 / 1_000_000) * 0.28;

    expect(cost).toBeCloseTo(expected, 10);
  });

  it('возвращает null для неизвестной модели', () => {
    expect(estimateCostUsd('unknown-model', 100, 0, 100)).toBeNull();
  });

  it.each([
    [null, 0, 100],
    [100, 0, null],
  ])(
    'возвращает null при отсутствующих токенах (input=%s, cached=%s, output=%s)',
    (inputTokens, cachedInputTokens, outputTokens) => {
      expect(
        estimateCostUsd('deepseek-v4-pro', inputTokens, cachedInputTokens, outputTokens),
      ).toBeNull();
    },
  );

  it('не уходит в отрицательные значения, если кэшированных токенов больше входных', () => {
    const cost = estimateCostUsd('deepseek-v4-pro', 10, 50, 0);

    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it('трактует отсутствующие кэшированные токены как ноль', () => {
    const cost = estimateCostUsd('deepseek-v4-flash', 1_000_000, null, 0);

    expect(cost).toBeCloseTo(0.14, 10);
  });
});
