'use client';

import { ArrowUp, ChevronDown, Square } from 'lucide-react';
import {
  type KeyboardEvent,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import { MarkdownMessage } from '@/components/markdown-message';
import { SectionHeader } from '@/components/section-header';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/textarea';
import {
  COMPARISON_MAX_OUTPUT_TOKENS,
  COMPARISON_VARIANTS,
  MAX_COMPARISON_PROMPT_LENGTH,
  comparisonHistory,
  type ComparisonTurn,
  type ComparisonVariant,
  type ComparisonVariantId,
} from '@/lib/comparison';
import { requestComparison } from '@/lib/comparison-client';

type Column = { variant: ComparisonVariant; turns: ComparisonTurn[] };
const emptyColumns = (): Column[] =>
  COMPARISON_VARIANTS.map((variant) => ({ variant, turns: [] }));

function ComparisonColumn({ variant, turns }: Column) {
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const latest = turns.at(-1);
  useEffect(() => {
    const container = messagesRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [turns]);

  const status =
    latest?.status === 'preparing'
      ? 'Создаём промпт…'
      : latest?.status === 'streaming'
        ? 'Генерация…'
        : latest?.status === 'complete'
          ? 'Готово'
          : latest?.status === 'stopped'
            ? 'Остановлено'
            : latest?.status === 'error'
              ? 'Ошибка'
              : 'Ожидание';

  return (
    <article
      className="comparison-column"
      aria-label={`Чат ${variant.id}: ${variant.title}`}
    >
      <div className="comparison-column-header">
        <h2 className="comparison-column-title">
          <span>{variant.id}</span>
          {variant.title}
        </h2>
        <label
          className="format-label"
          htmlFor={`comparison-system-${variant.id}`}
        >
          Системный промпт
        </label>
        <Textarea
          id={`comparison-system-${variant.id}`}
          value={variant.systemPrompt}
          readOnly
          rows={4}
          placeholder="Пустой — не передаётся"
          className="comparison-system-input resize-none text-xs md:text-xs"
        />
        <p className="comparison-description">{variant.description}</p>
        <output className="comparison-status" aria-live="polite">
          {status}
        </output>
      </div>
      <div ref={messagesRef} className="comparison-messages">
        {turns.length === 0 ? (
          <p className="comparison-placeholder">
            Введите общую задачу сверху и нажмите «Сравнить».
          </p>
        ) : null}
        {turns.map((turn) => (
          <div key={turn.id} className="comparison-turn">
            <p className="message-author">Вы</p>
            <p className="comparison-user-message">{turn.prompt}</p>
            {turn.actualPrompt && turn.actualPrompt !== turn.prompt ? (
              <Collapsible className="comparison-prompt-details">
                <CollapsibleTrigger className="comparison-prompt-trigger">
                  {variant.id === 4
                    ? 'Сгенерированный промпт'
                    : 'Фактический промпт'}
                  <ChevronDown className="size-3" aria-hidden="true" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <p className="whitespace-pre-wrap break-words pt-2">
                    {turn.actualPrompt}
                  </p>
                </CollapsibleContent>
              </Collapsible>
            ) : null}
            <p className="message-author">DeepSeek</p>
            {turn.answer ? (
              <div className="markdown-body comparison-answer">
                <MarkdownMessage content={turn.answer} />
              </div>
            ) : null}
            {turn.status === 'preparing' || turn.status === 'streaming' ? (
              <p className="comparison-placeholder">
                {turn.status === 'preparing'
                  ? 'Создание промпта перед решением…'
                  : 'DeepSeek отвечает…'}
              </p>
            ) : null}
            {turn.error ? (
              <p className="comparison-error" role="alert">
                {turn.error}
              </p>
            ) : null}
            {turn.status === 'stopped' ? (
              <p className="comparison-placeholder">Генерация остановлена</p>
            ) : null}
            {turn.outputTokens !== undefined ||
            turn.promptOutputTokens !== undefined ? (
              <p className="comparison-usage">
                {turn.outputTokens !== undefined
                  ? `Ответ: ${turn.outputTokens} токенов`
                  : ''}
                {turn.promptOutputTokens !== undefined
                  ? `${turn.outputTokens !== undefined ? ' · ' : ''}Создание промпта: ${turn.promptOutputTokens} токенов`
                  : ''}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </article>
  );
}

export function Comparison() {
  const [input, setInput] = useState('');
  const [columns, setColumns] = useState<Column[]>(emptyColumns);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef<{ id: string; controllers: AbortController[] } | null>(
    null,
  );

  useEffect(
    () => () => {
      runRef.current?.controllers.forEach((controller) => controller.abort());
    },
    [],
  );

  const stop = () =>
    runRef.current?.controllers.forEach((controller) => controller.abort());
  const clear = () => {
    stop();
    runRef.current = null;
    setIsRunning(false);
    setColumns(emptyColumns());
    setInput('');
    setError(null);
  };

  const send = async () => {
    const prompt = input.trim();
    if (runRef.current || !prompt) return;
    if (input.length > MAX_COMPARISON_PROMPT_LENGTH) {
      setError(
        `Промпт не должен превышать ${MAX_COMPARISON_PROMPT_LENGTH} символов.`,
      );
      return;
    }
    const id = crypto.randomUUID();
    const controllers = columns.map(() => new AbortController());
    runRef.current = { id, controllers };
    setIsRunning(true);
    setInput('');
    setError(null);
    setColumns((current) =>
      current.map((column) => ({
        ...column,
        turns: [
          ...column.turns,
          {
            id,
            prompt,
            answer: '',
            status: column.variant.id === 4 ? 'preparing' : 'streaming',
          },
        ],
      })),
    );

    const update = (
      variantId: ComparisonVariantId,
      apply: (turn: ComparisonTurn) => ComparisonTurn,
    ) => {
      if (runRef.current?.id !== id) return;
      setColumns((current) =>
        current.map((column) =>
          column.variant.id === variantId
            ? {
                ...column,
                turns: column.turns.map((turn) =>
                  turn.id === id ? apply(turn) : turn,
                ),
              }
            : column,
        ),
      );
    };

    await Promise.all(
      columns.map(async (column, index) => {
        const controller = controllers[index];
        try {
          await requestComparison(
            {
              variant: column.variant.id,
              prompt,
              messages: comparisonHistory(column.turns),
            },
            controller.signal,
            (event) => {
              if (event.type === 'prepared') {
                update(column.variant.id, (turn) => ({
                  ...turn,
                  actualPrompt: event.prompt,
                  promptOutputTokens: event.promptOutputTokens,
                  status: 'streaming',
                }));
              } else if (event.type === 'delta') {
                update(column.variant.id, (turn) => ({
                  ...turn,
                  answer: turn.answer + event.content,
                }));
              } else if (event.type === 'done') {
                update(column.variant.id, (turn) => ({
                  ...turn,
                  status: 'complete',
                  outputTokens: event.outputTokens,
                }));
              }
            },
          );
        } catch (caught) {
          update(column.variant.id, (turn) => ({
            ...turn,
            status: controller.signal.aborted ? 'stopped' : 'error',
            error: controller.signal.aborted
              ? undefined
              : caught instanceof Error && !(caught instanceof SyntaxError)
                ? caught.message
                : 'Не удалось получить ответ от DeepSeek.',
          }));
        }
      }),
    );
    if (runRef.current?.id === id) {
      runRef.current = null;
      setIsRunning(false);
    }
  };

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="comparison-frame">
      <SectionHeader
        title="Сравнение"
        subtitle="сравнение ответов для разных системных промптов"
        clearLabel="Очистить сравнение"
        canClear={columns.some((column) => column.turns.length > 0)}
        onClear={clear}
      />
      <form className="comparison-composer" onSubmit={onSubmit}>
        <label className="format-label" htmlFor="comparison-user-prompt">
          Пользовательский промпт для всех чатов
        </label>
        <div className="comparison-composer-row">
          <Textarea
            id="comparison-user-prompt"
            value={input}
            rows={2}
            maxLength={MAX_COMPARISON_PROMPT_LENGTH}
            placeholder="Введите задачу для сравнения пяти подходов…"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            className="comparison-user-input"
            aria-describedby="comparison-hint"
          />
          {isRunning ? (
            <Button type="button" onClick={stop} variant="secondary">
              <Square className="size-3 fill-current" />
              Остановить
            </Button>
          ) : (
            <Button type="submit" disabled={!input.trim()}>
              <ArrowUp className="size-4" />
              Сравнить
            </Button>
          )}
        </div>
        <p id="comparison-hint" className="comparison-hint">
          Одна отправка — до 6 запросов. Лимит каждого:{' '}
          {COMPARISON_MAX_OUTPUT_TOKENS} токенов, без целевой длины. Истории
          раздельные. Enter — отправить, Shift + Enter — новая строка.
        </p>
        {error ? (
          <p className="comparison-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
      <section
        className="comparison-columns"
        aria-label="Пять чатов для сравнения"
      >
        <div className="comparison-grid">
          {columns.map((column) => (
            <ComparisonColumn key={column.variant.id} {...column} />
          ))}
        </div>
      </section>
    </div>
  );
}
