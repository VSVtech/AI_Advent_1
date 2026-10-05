import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AgentSetup } from '@/components/agent-setup';
import { MAX_DIALOGUE_GOAL_LENGTH } from '@/lib/task-memory';

describe('настройка RAG-чата', () => {
  it('оставляет только название, модель и цель диалога', () => {
    const markup = renderToStaticMarkup(
      <AgentSetup onCreate={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(markup).toContain('Новый RAG-чат');
    expect(markup).toContain('id="agent-name"');
    expect(markup).toContain('id="agent-model"');
    expect(markup).toContain('id="agent-goal"');
    expect(markup).toContain(`maxLength="${MAX_DIALOGUE_GOAL_LENGTH}"`);
    expect(markup).not.toContain('Температура');
    expect(markup).not.toContain('Лимит контекстного окна');
    expect(markup).not.toContain('Системный промпт');
  });

  it('объясняет обязательные возможности чата', () => {
    const markup = renderToStaticMarkup(
      <AgentSetup onCreate={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(markup).toContain('RAG при каждом вопросе');
    expect(markup).toContain('Источники обязательны');
    expect(markup).toContain('Память задачи');
    expect(markup).toContain('Создать чат');
  });
});
