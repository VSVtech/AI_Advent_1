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

  it('предлагает четыре взаимоисключающих режима контекста', () => {
    const markup = renderToStaticMarkup(
      <AgentSetup onCreate={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(markup).toContain('Без сжатия');
    expect(markup).toContain('Sliding Window');
    expect(markup).toContain('Sticky Facts');
    expect(markup).toContain('Branching');
    expect(markup).toContain('Полная история всегда сохраняется');
    expect(markup.match(/type="radio"/g)).toHaveLength(4);
    expect(markup).toMatch(
      /type="radio" id="agent-context-none"[^>]*checked=""/,
    );
  });
});
