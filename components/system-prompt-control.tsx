'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { MAX_CUSTOM_SYSTEM_PROMPT_LENGTH } from '@/lib/chat-prompts';

export function SystemPromptControl({
  useSystemPrompt,
  useSelectorSystemPrompt,
  value,
  hasInvalidCustomSystemPrompt,
  isGenerating,
  onUseSystemPromptChange,
  onUseSelectorSystemPromptChange,
  onValueChange,
}: {
  useSystemPrompt: boolean;
  useSelectorSystemPrompt: boolean;
  value: string;
  hasInvalidCustomSystemPrompt: boolean;
  isGenerating: boolean;
  onUseSystemPromptChange: (checked: boolean) => void;
  onUseSelectorSystemPromptChange: (checked: boolean) => void;
  onValueChange: (value: string) => void;
}) {
  return (
    <div className="system-prompt-control">
      <div className="system-prompt-header">
        <label className="system-prompt-toggle" htmlFor="use-system-prompt">
          <Checkbox
            id="use-system-prompt"
            checked={useSystemPrompt}
            disabled={isGenerating}
            onCheckedChange={onUseSystemPromptChange}
          />
          Использовать системный промпт
        </label>
        {useSystemPrompt ? (
          <label
            className="system-prompt-toggle"
            htmlFor="use-selector-system-prompt"
          >
            <Checkbox
              id="use-selector-system-prompt"
              checked={useSelectorSystemPrompt}
              disabled={isGenerating}
              onCheckedChange={onUseSelectorSystemPromptChange}
            />
            Использовать промпт из селекторов
          </label>
        ) : null}
      </div>
      {useSystemPrompt ? (
        <>
          <Textarea
            id="system-prompt"
            aria-label="Системный промпт"
            rows={3}
            value={value}
            readOnly={useSelectorSystemPrompt || isGenerating}
            maxLength={MAX_CUSTOM_SYSTEM_PROMPT_LENGTH}
            onChange={(event) => onValueChange(event.target.value)}
            aria-describedby={
              hasInvalidCustomSystemPrompt
                ? 'system-prompt-hint system-prompt-error'
                : 'system-prompt-hint'
            }
            aria-invalid={hasInvalidCustomSystemPrompt || undefined}
            placeholder={
              useSelectorSystemPrompt
                ? 'Укажите корректную целевую длину для предпросмотра.'
                : 'Задайте роль, стиль, формат и длину ответа…'
            }
            className="system-prompt-input"
          />
          <p id="system-prompt-hint" className="system-prompt-hint">
            {useSelectorSystemPrompt
              ? 'Промпт обновляется при изменении формата и целевой длины. Снимите галочку «Использовать промпт из селекторов», чтобы редактировать.'
              : 'Ваш текст заменяет инструкции из селекторов. Проверка формата и макс. токенов действуют — опишите нужный формат и длину в промпте.'}
          </p>
          {hasInvalidCustomSystemPrompt ? (
            <p id="system-prompt-error" className="system-prompt-error">
              Введите системный промпт от 1 до {MAX_CUSTOM_SYSTEM_PROMPT_LENGTH}{' '}
              символов.
            </p>
          ) : null}
        </>
      ) : (
        <p className="system-prompt-hint">
          Системный промпт не отправляется. Нужный формат и длину укажите в
          сообщении. Температура, лимит токенов и проверка формата сохраняются.
        </p>
      )}
    </div>
  );
}
