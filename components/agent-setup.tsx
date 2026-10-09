'use client';
import { isLocalModel, LOCAL_CONTEXT_TOKENS } from '@/lib/model-provider';

import { Sparkles } from 'lucide-react';
import { type SyntheticEvent, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAvailableModels } from '@/hooks/use-available-models';
import { createDefaultAgentConfig, type AgentConfig } from '@/lib/agent';
import { DEFAULT_MODEL, formatModelLabel } from '@/lib/chat-constraints';
import {
  MAX_DIALOGUE_GOAL_LENGTH,
  normalizeDialogueGoal,
} from '@/lib/task-memory';

export function AgentSetup({
  onCreate,
  onCancel,
}: {
  onCreate: (config: AgentConfig, name: string) => void;
  onCancel: () => void;
}) {
  const { models: availableModels, error: modelsError } =
    useAvailableModels(true);
  const [useRag, setUseRag] = useState(true);
  const [useMemory, setUseMemory] = useState(true);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const selectedModel = availableModels.includes(model)
    ? model
    : (availableModels[0] ?? DEFAULT_MODEL);
  const normalizedGoal = normalizeDialogueGoal(goal);

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (normalizedGoal === null) return;
    onCreate(
      {
        ...createDefaultAgentConfig(),
        model: selectedModel,
        useRag,
        useMemory,
        taskGoal: useMemory ? normalizedGoal : '',
        ...(isLocalModel(selectedModel)
          ? {
              contextWindowTokens: LOCAL_CONTEXT_TOKENS,
              temperature: 0.3,
              targetOutputTokens: null,
            }
          : {}),
      },
      name.trim() || `Агент · ${formatModelLabel(selectedModel)}`,
    );
  };

  return (
    <div className="agent-setup">
      <header className="chat-header shrink-0">
        <div className="flex min-w-0 items-center gap-3">
          <span className="brand-mark shrink-0" aria-hidden="true">
            <Sparkles className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-[-0.01em] text-white">
              Новый агент
            </h1>
            <p className="truncate text-xs text-white/40">
              Выберите модель, базу знаний и память
            </p>
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Отмена
        </Button>
      </header>

      <form
        className="agent-setup-form mx-auto w-full max-w-3xl"
        onSubmit={handleSubmit}
      >
        <section className="grid gap-4 rounded-2xl border border-white/8 bg-white/[0.025] p-4 sm:p-5">
          <div>
            <h2 className="text-base font-semibold text-white/90">
              Основные настройки
            </h2>
            <p className="mt-1 text-sm leading-5 text-white/45">
              Остальные параметры используют проверенные значения по умолчанию.
            </p>
          </div>

          <div className="grid min-w-0 gap-4">
            <div className="agent-setup-field">
              <label className="format-label" htmlFor="agent-name">
                Название
              </label>
              <Input
                id="agent-name"
                value={name}
                placeholder={`Агент · ${formatModelLabel(selectedModel)}`}
                onChange={(event) => setName(event.target.value)}
                className="agent-setup-input"
              />
            </div>

            <div className="agent-setup-field">
              <label className="format-label" htmlFor="agent-model">
                Модель ответа
              </label>
              <Select
                value={selectedModel}
                onValueChange={(value) => {
                  if (typeof value === 'string') setModel(value);
                }}
              >
                <SelectTrigger
                  id="agent-model"
                  className="agent-setup-input w-full min-w-0 whitespace-normal data-[size=default]:h-auto min-h-9 *:data-[slot=select-value]:line-clamp-none"
                  title={modelsError ?? undefined}
                >
                  <SelectValue className="min-w-0 break-words whitespace-normal">
                    {formatModelLabel(selectedModel)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="format-menu">
                  {availableModels.map((id) => (
                    <SelectItem
                      key={id}
                      value={id}
                      className="format-option [&>span]:min-w-0 [&>span]:shrink [&>span]:whitespace-normal [&>span]:break-words"
                    >
                      {formatModelLabel(id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {modelsError ? (
                <p className="system-prompt-hint">{modelsError}</p>
              ) : null}
            </div>
          </div>

          <div className="agent-setup-field">
            <label className="format-label" htmlFor="agent-goal">
              Цель диалога{' '}
              <span className="text-white/30">· необязательно</span>
            </label>
            <Textarea
              id="agent-goal"
              disabled={!useMemory}
              value={goal}
              maxLength={MAX_DIALOGUE_GOAL_LENGTH}
              placeholder="Например: подготовить план интеграции RAG в продуктовый чат"
              className="min-h-24 resize-y border-white/8 bg-white/[0.035] text-sm text-white/75"
              onChange={(event) => setGoal(event.target.value)}
            />
            <p className="system-prompt-hint">
              Цель попадёт в память задачи. Её можно уточнять в самом диалоге.
            </p>
          </div>
        </section>

        <section
          className="grid gap-3 sm:grid-cols-2"
          aria-label="Возможности чата"
        >
          <label
            aria-label="Использовать RAG"
            className="flex cursor-pointer items-start gap-3 rounded-2xl border border-emerald-200/10 bg-emerald-300/[0.035] p-4"
          >
            <input
              type="checkbox"
              checked={useRag}
              onChange={(e) => setUseRag(e.target.checked)}
              className="mt-1 size-4 accent-emerald-400"
            />
            <span>
              <span className="block text-sm font-semibold text-white/85">
                Использовать RAG
              </span>
              <span className="mt-1 block text-xs leading-5 text-white/45">
                Поиск по базе знаний, источники и проверка цитат. При слабом
                контексте — отказ.
              </span>
            </span>
          </label>
          <label
            aria-label="Использовать память"
            className="flex cursor-pointer items-start gap-3 rounded-2xl border border-emerald-200/10 bg-emerald-300/[0.035] p-4"
          >
            <input
              type="checkbox"
              checked={useMemory}
              onChange={(e) => setUseMemory(e.target.checked)}
              className="mt-1 size-4 accent-emerald-400"
            />
            <span>
              <span className="block text-sm font-semibold text-white/85">
                Использовать память
              </span>
              <span className="mt-1 block text-xs leading-5 text-white/45">
                Цель, ограничения и термины извлекает выбранная модель:{' '}
                {formatModelLabel(selectedModel)}. История чата сохраняется при
                любом выборе.
              </span>
            </span>
          </label>
        </section>
        {isLocalModel(selectedModel) && (
          <p className="system-prompt-hint">
            Ответы и память обрабатываются локально через Ollama. RAG также
            работает локально. Поддерживаются текстовые вложения.
          </p>
        )}

        {normalizedGoal === null ? (
          <p role="alert" className="system-prompt-error">
            Цель не должна превышать {MAX_DIALOGUE_GOAL_LENGTH} символов или
            содержать управляющие символы.
          </p>
        ) : null}

        <div className="agent-setup-actions">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Отмена
          </Button>
          <Button type="submit" disabled={normalizedGoal === null}>
            Создать чат
          </Button>
        </div>
      </form>
    </div>
  );
}
