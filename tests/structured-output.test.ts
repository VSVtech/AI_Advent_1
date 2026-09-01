import { describe, expect, it } from 'vitest';

import { validateStructuredOutput } from '@/lib/structured-output';

describe('validateStructuredOutput', () => {
  it('принимает JSON-объект и отклоняет массив или Markdown', () => {
    expect(validateStructuredOutput('{"answer": 42}', 'json')).toBe(true);
    expect(validateStructuredOutput('[1, 2, 3]', 'json')).toBe(false);
    expect(
      validateStructuredOutput('```json\n{"answer": 42}\n```', 'json'),
    ).toBe(false);
  });

  it('проверяет корректность XML', () => {
    expect(
      validateStructuredOutput(
        '<response><answer>42</answer></response>',
        'xml',
      ),
    ).toBe(true);
    expect(validateStructuredOutput('<response><answer></response>', 'xml')).toBe(
      false,
    );
    expect(
      validateStructuredOutput(
        '<response>Тема: Квантовая запутанность Объяснение: Простыми словами</response>',
        'xml',
      ),
    ).toBe(false);
    expect(
      validateStructuredOutput(
        '<response><topic>Квантовая запутанность</topic><explanation>Простыми словами</explanation></response>',
        'xml',
      ),
    ).toBe(true);
    expect(
      validateStructuredOutput('<answer><value>42</value></answer>', 'xml'),
    ).toBe(false);
  });

  it('проверяет корректность YAML', () => {
    expect(validateStructuredOutput('answer: 42\nitems:\n  - one', 'yaml')).toBe(
      true,
    );
    expect(validateStructuredOutput('answer: [one', 'yaml')).toBe(false);
    expect(validateStructuredOutput('- one\n- two', 'yaml')).toBe(true);
    expect(
      validateStructuredOutput(
        'Пожалуйста, уточните тему для объяснения.',
        'yaml',
      ),
    ).toBe(false);
    expect(
      validateStructuredOutput(
        'YAML:\n  тема: Квантовая запутанность\n  объяснение: Простыми словами',
        'yaml',
      ),
    ).toBe(false);
    expect(validateStructuredOutput('```yaml\nanswer: 42\n```', 'yaml')).toBe(
      false,
    );
  });
});
