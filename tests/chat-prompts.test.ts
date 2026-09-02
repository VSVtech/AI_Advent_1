import { describe, expect, it } from 'vitest';

import {
  buildSelectorSystemPrompt,
  isValidCustomSystemPrompt,
  MAX_CUSTOM_SYSTEM_PROMPT_LENGTH,
} from '@/lib/chat-prompts';
import type { ChatOutputFormat } from '@/lib/chat-types';

describe('системный промпт', () => {
  it.each<[ChatOutputFormat, string]>([
    ['text', 'The complete answer must contain'],
    ['json', 'Return only valid json.'],
    ['xml', 'Return only well-formed XML'],
    ['yaml', 'Return only valid YAML'],
  ])('формирует предпросмотр для %s', (format, expectedStart) => {
    const prompt = buildSelectorSystemPrompt(format, 8000);

    expect(prompt.startsWith(expectedStart)).toBe(true);
    expect(prompt).toContain('between 7000 and 9000 output tokens');
    expect(prompt).toContain('approximately 4800 words');
  });

  it('учитывает технический максимум в предпросмотре', () => {
    expect(buildSelectorSystemPrompt('text', 98_000)).toContain(
      'between 85750 and 100000 output tokens',
    );
  });

  it('принимает непустой текст вплоть до лимита символов', () => {
    expect(isValidCustomSystemPrompt('Отвечай кратко.')).toBe(true);
    expect(isValidCustomSystemPrompt('  Промпт\nс новой строкой.  ')).toBe(
      true,
    );
    expect(
      isValidCustomSystemPrompt('a'.repeat(MAX_CUSTOM_SYSTEM_PROMPT_LENGTH)),
    ).toBe(true);
  });

  it.each([undefined, null, false, 123, {}, [], '', ' \n\t '])(
    'отклоняет некорректный промпт %j',
    (value) => {
      expect(isValidCustomSystemPrompt(value)).toBe(false);
    },
  );

  it('отклоняет промпт длиннее лимита', () => {
    expect(
      isValidCustomSystemPrompt(
        'a'.repeat(MAX_CUSTOM_SYSTEM_PROMPT_LENGTH + 1),
      ),
    ).toBe(false);
  });
});
