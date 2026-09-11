'use client';

import { Sparkles } from 'lucide-react';
import { type SyntheticEvent, useState } from 'react';

import { SystemPromptControl } from '@/components/system-prompt-control';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAvailableModels } from '@/hooks/use-available-models';
import type { AgentConfig } from '@/lib/agent';
import {
  calculateMaxOutputTokens,
  DEFAULT_MODEL,
  DEFAULT_TARGET_OUTPUT_TOKENS,
  DEFAULT_TEMPERATURE,
  formatModelLabel,
  isValidTargetOutputTokens,
  isValidTemperature,
  MAX_TARGET_OUTPUT_TOKENS,
  MAX_TEMPERATURE,
  MIN_TARGET_OUTPUT_TOKENS,
  MIN_TEMPERATURE,
} from '@/lib/chat-constraints';
import {
  buildSelectorSystemPrompt,
  isValidCustomSystemPrompt,
} from '@/lib/chat-prompts';
import type { ChatOutputFormat } from '@/lib/chat-types';

const outputFormats: Array<{ value: ChatOutputFormat; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'json', label: 'JSON' },
  { value: 'xml', label: 'XML' },
  { value: 'yaml', label: 'YAML' },
];

export function AgentSetup({
  onCreate,
  onCancel,
}: {
  onCreate: (config: AgentConfig, name: string) => void;
  onCancel: () => void;
}) {
  const { models: availableModels, error: modelsError } = useAvailableModels();
  const [name, setName] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [outputFormat, setOutputFormat] = useState<ChatOutputFormat>('text');
  const [temperature, setTemperature] = useState(String(DEFAULT_TEMPERATURE));
  const [hasTargetOutputTokens, setHasTargetOutputTokens] = useState(true);
  const [targetOutputTokens, setTargetOutputTokens] = useState(
    String(DEFAULT_TARGET_OUTPUT_TOKENS),
  );
  const [useSystemPrompt, setUseSystemPrompt] = useState(true);
  const [useSelectorSystemPrompt, setUseSelectorSystemPrompt] = useState(true);
  const [customSystemPrompt, setCustomSystemPrompt] = useState<string | null>(
    null,
  );

  const selectedModel = availableModels.includes(model)
    ? model
    : (availableModels[0] ?? DEFAULT_MODEL);
  const parsedTemperature = temperature.trim() ? Number(temperature) : NaN;
  const hasInvalidTemperature = !isValidTemperature(parsedTemperature);
  const parsedTargetOutputTokens = Number(targetOutputTokens);
  // Disabling the target length is always valid — the field's own value
  // only matters (and is only validated) while it's enabled.
  const hasInvalidTargetOutputTokens =
    hasTargetOutputTokens &&
    !isValidTargetOutputTokens(parsedTargetOutputTokens);
  const resolvedTargetOutputTokens = hasTargetOutputTokens
    ? parsedTargetOutputTokens
    : null;
  const generatedSystemPrompt =
    resolvedTargetOutputTokens === null ||
    isValidTargetOutputTokens(resolvedTargetOutputTokens)
      ? buildSelectorSystemPrompt(outputFormat, resolvedTargetOutputTokens)
      : '';
  const hasInvalidCustomSystemPrompt =
    useSystemPrompt &&
    !useSelectorSystemPrompt &&
    !isValidCustomSystemPrompt(customSystemPrompt);
  // Disabling the target length also disables the derived max-output cap —
  // the technical API ceiling applies instead (calculateMaxOutputTokens
  // returns it for a null target).
  const calculatedMaxOutputTokens =
    resolvedTargetOutputTokens === null ||
    isValidTargetOutputTokens(resolvedTargetOutputTokens)
      ? calculateMaxOutputTokens(resolvedTargetOutputTokens)
      : null;

  const canCreate =
    !hasInvalidTemperature &&
    !hasInvalidTargetOutputTokens &&
    !hasInvalidCustomSystemPrompt;

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate) return;

    onCreate(
      {
        model: selectedModel,
        temperature: parsedTemperature,
        outputFormat,
        targetOutputTokens: resolvedTargetOutputTokens,
        useSystemPrompt,
        useSelectorSystemPrompt,
        customSystemPrompt,
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
              Настройте модель и параметры ответа
            </p>
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Отмена
        </Button>
      </header>

      <form className="agent-setup-form" onSubmit={handleSubmit}>
        <div className="agent-setup-field">
          <label className="format-label" htmlFor="agent-name">
            Название агента
          </label>
          <Input
            id="agent-name"
            value={name}
            placeholder={`Агент · ${formatModelLabel(selectedModel)}`}
            onChange={(event) => setName(event.target.value)}
            className="agent-setup-input"
          />
        </div>

        <div className="agent-setup-row">
          <div className="agent-setup-field">
            <label className="format-label" htmlFor="agent-model">
              Модель
            </label>
            <Select
              value={selectedModel}
              onValueChange={(value) => {
                if (typeof value === 'string') setModel(value);
              }}
            >
              <SelectTrigger
                id="agent-model"
                className="agent-setup-input"
                title={modelsError ?? undefined}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="format-menu">
                {availableModels.map((id) => (
                  <SelectItem key={id} value={id} className="format-option">
                    {formatModelLabel(id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {modelsError ? (
              <p className="system-prompt-hint">{modelsError}</p>
            ) : null}
          </div>

          <div className="agent-setup-field">
            <label className="format-label" htmlFor="agent-temperature">
              Температура
            </label>
            <Input
              id="agent-temperature"
              type="number"
              inputMode="decimal"
              min={MIN_TEMPERATURE}
              max={MAX_TEMPERATURE}
              step={0.1}
              value={temperature}
              aria-invalid={hasInvalidTemperature || undefined}
              className="agent-setup-input"
              onChange={(event) => setTemperature(event.target.value)}
            />
          </div>

          <div className="agent-setup-field">
            <label className="format-label" htmlFor="agent-format">
              Формат ответа
            </label>
            <Select
              value={outputFormat}
              onValueChange={(value) => {
                if (
                  typeof value === 'string' &&
                  outputFormats.some((option) => option.value === value)
                ) {
                  setOutputFormat(value as ChatOutputFormat);
                }
              }}
            >
              <SelectTrigger id="agent-format" className="agent-setup-input">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="format-menu">
                {outputFormats.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    className="format-option"
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="agent-setup-field">
            <div className="agent-setup-field-heading">
              <label className="format-label" htmlFor="agent-target-tokens">
                Целевая длина ответа
              </label>
              <label
                className="agent-setup-checkbox-label"
                htmlFor="agent-target-tokens-disabled"
              >
                <Checkbox
                  id="agent-target-tokens-disabled"
                  checked={!hasTargetOutputTokens}
                  onCheckedChange={(checked) =>
                    setHasTargetOutputTokens(!checked)
                  }
                />
                Без ограничения
              </label>
            </div>
            <Input
              id="agent-target-tokens"
              type="number"
              inputMode="numeric"
              min={MIN_TARGET_OUTPUT_TOKENS}
              max={MAX_TARGET_OUTPUT_TOKENS}
              step={50}
              value={targetOutputTokens}
              disabled={!hasTargetOutputTokens}
              aria-invalid={hasInvalidTargetOutputTokens || undefined}
              className="agent-setup-input"
              onChange={(event) => setTargetOutputTokens(event.target.value)}
            />
            <p className="system-prompt-hint">
              {hasTargetOutputTokens
                ? `Максимум токенов на ответ: ${calculatedMaxOutputTokens ?? '—'}`
                : `Длина не ограничивается; технический предел API — ${calculatedMaxOutputTokens} токенов.`}
            </p>
          </div>
        </div>

        {hasInvalidTemperature ? (
          <p role="alert" className="system-prompt-error">
            Укажите температуру от {MIN_TEMPERATURE} до {MAX_TEMPERATURE}.
          </p>
        ) : null}
        {hasInvalidTargetOutputTokens ? (
          <p role="alert" className="system-prompt-error">
            Укажите целевую длину от {MIN_TARGET_OUTPUT_TOKENS} до{' '}
            {MAX_TARGET_OUTPUT_TOKENS} токенов, либо отметьте «Без ограничения».
          </p>
        ) : null}

        <SystemPromptControl
          useSystemPrompt={useSystemPrompt}
          useSelectorSystemPrompt={useSelectorSystemPrompt}
          value={
            useSelectorSystemPrompt
              ? generatedSystemPrompt
              : (customSystemPrompt ?? '')
          }
          hasInvalidCustomSystemPrompt={hasInvalidCustomSystemPrompt}
          isGenerating={false}
          onUseSystemPromptChange={setUseSystemPrompt}
          onUseSelectorSystemPromptChange={(checked) => {
            if (!checked && customSystemPrompt === null) {
              setCustomSystemPrompt(generatedSystemPrompt);
            }
            setUseSelectorSystemPrompt(checked);
          }}
          onValueChange={setCustomSystemPrompt}
        />

        <div className="agent-setup-actions">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Отмена
          </Button>
          <Button type="submit" disabled={!canCreate}>
            Создать агента
          </Button>
        </div>
      </form>
    </div>
  );
}
