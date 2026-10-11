'use client';
import { isLocalModel, LOCAL_CONTEXT_TOKENS } from '@/lib/model-provider';
import { LOCAL_RAG_PROFILES } from '@/lib/local-rag-profile';

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
import {
  DEFAULT_MODEL,
  formatModelLabel,
  isValidTemperature,
  isValidContextWindowTokens,
  isValidMaxOutputTokens,
  MIN_TEMPERATURE,
  MAX_TEMPERATURE,
  MIN_CONTEXT_WINDOW_TOKENS,
  MIN_TARGET_OUTPUT_TOKENS,
} from '@/lib/chat-constraints';
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
  const [compactRag, setCompactRag] = useState(true);
  const [temperature, setTemperature] = useState(
    String(LOCAL_RAG_PROFILES.compact.temperature),
  );
  const [contextTokens, setContextTokens] = useState(
    String(LOCAL_RAG_PROFILES.compact.contextTokens),
  );
  const [outputTokens, setOutputTokens] = useState(
    String(LOCAL_RAG_PROFILES.compact.maxOutputTokens),
  );
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const selectedModel = availableModels.includes(model)
    ? model
    : (availableModels[0] ?? DEFAULT_MODEL);
  const normalizedGoal = normalizeDialogueGoal(goal);
  const local = isLocalModel(selectedModel);
  const validLocalSettings =
    !local ||
    (temperature.trim() !== '' &&
      isValidTemperature(Number(temperature)) &&
      isValidContextWindowTokens(Number(contextTokens)) &&
      Number(contextTokens) <= LOCAL_CONTEXT_TOKENS &&
      isValidMaxOutputTokens(Number(outputTokens)) &&
      Number(outputTokens) <= 8192 &&
      Number(outputTokens) < Number(contextTokens));

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (normalizedGoal === null || !validLocalSettings) return;
    onCreate(
      {
        ...createDefaultAgentConfig(),
        model: selectedModel,
        useRag,
        useMemory,
        taskGoal: useMemory ? normalizedGoal : '',
        ...(isLocalModel(selectedModel)
          ? {
              localRagProfile: useRag && compactRag ? 'compact' : 'baseline',
              contextWindowTokens: Number(contextTokens),
              temperature: Number(temperature),
              maxOutputTokens: Number(outputTokens),
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

          {local ? (
            <fieldset className="grid min-w-0 gap-3 rounded-xl border border-white/10 p-3">
              <legend className="px-1 text-sm text-white/75">
                Параметры локальной модели
              </legend>
              <div className="grid min-w-0 gap-3 sm:grid-cols-3">
                <div className="agent-setup-field min-w-0">
                  <label className="format-label" htmlFor="local-temperature">
                    Температура
                  </label>
                  <Input
                    id="local-temperature"
                    type="number"
                    min={MIN_TEMPERATURE}
                    max={MAX_TEMPERATURE}
                    step="any"
                    required
                    value={temperature}
                    onChange={(e) => setTemperature(e.target.value)}
                    className="agent-setup-input w-full min-w-0"
                  />
                  <p className="system-prompt-hint">
                    0–2. Ниже — более предсказуемые ответы.
                  </p>
                </div>
                <div className="agent-setup-field min-w-0">
                  <label className="format-label" htmlFor="local-context">
                    Контекст, токенов
                  </label>
                  <Input
                    id="local-context"
                    type="number"
                    min={MIN_CONTEXT_WINDOW_TOKENS}
                    max={LOCAL_CONTEXT_TOKENS}
                    step="1"
                    required
                    value={contextTokens}
                    onChange={(e) => setContextTokens(e.target.value)}
                    className="agent-setup-input w-full min-w-0"
                  />
                  <p className="system-prompt-hint">
                    До 32 768: история, документы и ответ.
                  </p>
                </div>
                <div className="agent-setup-field min-w-0">
                  <label className="format-label" htmlFor="local-output">
                    Максимум ответа, токенов
                  </label>
                  <Input
                    id="local-output"
                    type="number"
                    min={MIN_TARGET_OUTPUT_TOKENS}
                    max={8192}
                    step="1"
                    required
                    value={outputTokens}
                    onChange={(e) => setOutputTokens(e.target.value)}
                    className="agent-setup-input w-full min-w-0"
                  />
                  <p className="system-prompt-hint">
                    50–8192, меньше размера контекста.
                  </p>
                </div>
              </div>
              {!validLocalSettings ? (
                <p role="alert" className="system-prompt-error">
                  Проверьте диапазоны: температура 0–2, контекст 100–32 768,
                  ответ 50–8192 токена и меньше контекста.
                </p>
              ) : null}
            </fieldset>
          ) : null}

          {local && useRag ? (
            <label
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 p-3"
              aria-label="Использовать шаблон ответа для базы знаний"
            >
              <input
                type="checkbox"
                checked={compactRag}
                onChange={(event) => setCompactRag(event.target.checked)}
                className="mt-1 size-4 accent-emerald-400"
              />
              <span className="text-sm text-white/75">
                Использовать шаблон ответа для базы знаний
                <span className="mt-1 block text-xs leading-5 text-white/45">
                  Короткие факты, строгая схема цитат и явные ссылки на
                  источники. Без галочки — стандартный RAG-шаблон. Числовые
                  настройки не меняются.
                </span>
              </span>
            </label>
          ) : null}

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
          <Button
            type="submit"
            disabled={normalizedGoal === null || !validLocalSettings}
          >
            Создать чат
          </Button>
        </div>
      </form>
    </div>
  );
}
