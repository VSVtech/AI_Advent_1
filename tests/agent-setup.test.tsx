import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AgentSetup } from '@/components/agent-setup';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MAX_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
} from '@/lib/chat-constraints';

describe('настройка агента', () => {
  it('показывает поле искусственного лимита контекстного окна', () => {
    const markup = renderToStaticMarkup(
      <AgentSetup onCreate={vi.fn()} onCancel={vi.fn()} />,
    );
    const input = markup.match(
      /<input\b[^>]*id="agent-context-window"[^>]*>/,
    )?.[0];

    expect(markup).toContain('Лимит контекстного окна');
    expect(markup).toContain('Для теста переполнения');
    expect(input).toContain(`min="${MIN_CONTEXT_WINDOW_TOKENS}"`);
    expect(input).toContain(`max="${MAX_CONTEXT_WINDOW_TOKENS}"`);
    expect(input).toContain(`value="${DEFAULT_CONTEXT_WINDOW_TOKENS}"`);
  });

  it('предлагает включённое по умолчанию сжатие контекста', () => {
    const markup = renderToStaticMarkup(
      <AgentSetup onCreate={vi.fn()} onCancel={vi.fn()} />,
    );
    const checkbox = markup.match(
      /<[^>]+id="agent-context-compression"[^>]*>/,
    )?.[0];

    expect(markup).toContain('Использовать сжатие контекста');
    expect(markup).toContain('последние 10 сообщений как есть');
    expect(checkbox).toContain('checked=""');
  });
});
