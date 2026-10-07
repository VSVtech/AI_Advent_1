import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AgentSetup } from '@/components/agent-setup';
import { MAX_DIALOGUE_GOAL_LENGTH } from '@/lib/task-memory';

describe('настройка агента', () => {
  it('сохраняет компактные настройки агента', () => {
    const markup = renderToStaticMarkup(
      <AgentSetup onCreate={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(markup).toContain('Новый агент');
    expect(markup).toContain('id="agent-name"');
    expect(markup).toContain('id="agent-model"');
    expect(markup).toContain('id="agent-goal"');
    expect(markup).toContain(`maxLength="${MAX_DIALOGUE_GOAL_LENGTH}"`);
    expect(markup).not.toContain('Температура');
    expect(markup).not.toContain('Лимит контекстного окна');
    expect(markup).not.toContain('Системный промпт');
  });

  it('позволяет включать RAG и память независимо', () => {
    const markup = renderToStaticMarkup(
      <AgentSetup onCreate={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(markup).toContain('Использовать RAG');
    expect(markup).toContain('проверка цитат');
    expect(markup).toContain('Использовать память');
    expect(markup.match(/type="checkbox"/g)).toHaveLength(2);
    expect(markup).toContain('Создать чат');
  });
});
