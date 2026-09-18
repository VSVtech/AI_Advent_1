'use client';

import { BrainCircuit, Trash2 } from 'lucide-react';
import { type SyntheticEvent, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Agent } from '@/lib/agent';
import {
  MAX_MEMORY_KEY_LENGTH,
  MAX_MEMORY_VALUE_LENGTH,
  MAX_SHARED_LONG_TERM_MEMORY_ENTRIES,
  type EditableMemoryLayer,
  type LongTermMemoryKind,
  type MemoryEntry,
} from '@/lib/memory-layers';

const kindLabels: Record<LongTermMemoryKind, string> = {
  profile: 'Профиль',
  decision: 'Решение',
  knowledge: 'Знание',
};

function MemoryEntries({
  entries,
  layer,
  agent,
  disabled,
}: {
  entries: MemoryEntry[];
  layer: EditableMemoryLayer;
  agent: Agent;
  disabled: boolean;
}) {
  if (entries.length === 0) {
    return <p className="mt-3 text-sm text-white/45">Пока нет записей.</p>;
  }

  return (
    <ul className="mt-3 max-h-44 space-y-2 overflow-y-auto pr-1">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="flex items-start justify-between gap-2 rounded-lg bg-white/[0.035] p-2"
        >
          <div className="min-w-0 text-sm leading-5">
            <p className="break-words font-medium text-white/85">
              {entry.kind ? `${kindLabels[entry.kind]} · ` : ''}
              {entry.key}
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words text-white/60">
              {entry.value}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-white/45 hover:text-red-200"
            aria-label={`Удалить «${entry.key}» из ${layer === 'working' ? 'рабочей' : 'долговременной'} памяти`}
            disabled={disabled}
            onClick={() => agent.deleteMemoryEntry(layer, entry.id)}
          >
            <Trash2 />
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function AgentMemoryDialog({
  agent,
  isGenerating,
}: {
  agent: Agent;
  isGenerating: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [layer, setLayer] = useState<EditableMemoryLayer>('working');
  const [kind, setKind] = useState<LongTermMemoryKind>('profile');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const memory = agent.getMemoryLayers();

  const handleSave = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!agent.saveMemoryEntry(layer, key, value, kind)) {
      setFeedback(
        `Не удалось сохранить: проверьте поля и лимит (${layer === 'working' ? '20 рабочих' : `${MAX_SHARED_LONG_TERM_MEMORY_ENTRIES} общих долговременных`} записей).`,
      );
      return;
    }
    setFeedback(
      `Запись сохранена в ${layer === 'working' ? 'рабочей' : 'долговременной'} памяти.`,
    );
    setKey('');
    setValue('');
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-9 gap-1.5 px-2 text-white/60 hover:bg-white/[0.055] hover:text-white"
        aria-label="Редактировать память"
        onClick={() => setOpen(true)}
      >
        <BrainCircuit className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">Изменить</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[min(88dvh,760px)] overflow-y-auto border border-white/10 bg-[#142021] text-white sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Память агента</DialogTitle>
            <DialogDescription className="text-white/55">
              История чата хранится отдельно. Агент автоматически извлекает
              факты текущего диалога в краткосрочную память и отбирает
              устойчивые сведения в общую долговременную. Рабочие заметки вы
              сохраняете вручную.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 md:grid-cols-3">
            <section className="min-w-0 rounded-xl border border-white/10 bg-white/[0.025] p-3">
              <h3 className="text-sm font-semibold text-white/85">
                Краткосрочная · фактов: {Object.keys(memory.shortTerm).length}
              </h3>
              <p className="mt-1 text-sm text-white/50">
                Факты текущего диалога, извлечённые отдельным LLM-агентом. Это
                не история сообщений.
              </p>
              {Object.keys(memory.shortTerm).length ? (
                <ul className="mt-2 space-y-2 text-sm text-white/65">
                  {Object.entries(memory.shortTerm).map(([key, value]) => (
                    <li key={key} className="break-words">
                      <span className="font-medium text-white/85">{key}:</span>{' '}
                      {value}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>

            <section className="min-w-0 rounded-xl border border-white/10 bg-white/[0.025] p-3">
              <h3 className="text-sm font-semibold text-white/85">
                Рабочая · записей: {memory.working.length}
              </h3>
              <p className="mt-1 text-sm text-white/50">
                Данные текущей задачи. В режиме веток у каждой ветки свои
                записи.
              </p>
              <MemoryEntries
                entries={memory.working}
                layer="working"
                agent={agent}
                disabled={isGenerating}
              />
            </section>

            <section className="min-w-0 rounded-xl border border-white/10 bg-white/[0.025] p-3">
              <h3 className="text-sm font-semibold text-white/85">
                Долговременная · записей: {memory.longTerm.length}
              </h3>
              <p className="mt-1 text-sm text-white/50">
                Профиль, решения и знания: агент отбирает их автоматически;
                также можно добавить вручную. Общая для всех агентов.
              </p>
              <MemoryEntries
                entries={memory.longTerm}
                layer="long-term"
                agent={agent}
                disabled={isGenerating}
              />
            </section>
          </div>

          <form
            className="grid gap-3 rounded-xl border border-emerald-200/15 bg-emerald-300/[0.035] p-3"
            onSubmit={handleSave}
          >
            <h3 className="text-sm font-semibold text-white/85">
              Сохранить запись
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm text-white/65">
                Слой памяти
                <select
                  value={layer}
                  onChange={(event) => {
                    setLayer(event.target.value as EditableMemoryLayer);
                    setFeedback(null);
                  }}
                  className="min-h-9 rounded-lg border border-white/15 bg-[#10191a] px-2 text-white"
                >
                  <option value="working">Рабочая</option>
                  <option value="long-term">Долговременная</option>
                </select>
              </label>
              {layer === 'long-term' ? (
                <label className="grid gap-1 text-sm text-white/65">
                  Тип записи
                  <select
                    value={kind}
                    onChange={(event) =>
                      setKind(event.target.value as LongTermMemoryKind)
                    }
                    className="min-h-9 rounded-lg border border-white/15 bg-[#10191a] px-2 text-white"
                  >
                    {Object.entries(kindLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            <label className="grid gap-1 text-sm text-white/65">
              Ключ
              <input
                value={key}
                onChange={(event) => setKey(event.target.value)}
                maxLength={MAX_MEMORY_KEY_LENGTH}
                required
                placeholder="Например: дедлайн"
                className="min-h-9 rounded-lg border border-white/15 bg-[#10191a] px-3 text-white outline-none focus:border-emerald-300/50"
              />
            </label>
            <label className="grid gap-1 text-sm text-white/65">
              Значение
              <textarea
                value={value}
                onChange={(event) => setValue(event.target.value)}
                maxLength={MAX_MEMORY_VALUE_LENGTH}
                required
                rows={2}
                placeholder="Что агент должен помнить?"
                className="min-h-20 resize-y rounded-lg border border-white/15 bg-[#10191a] px-3 py-2 text-white outline-none focus:border-emerald-300/50"
              />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-white/45">
                Повторный ключ в том же слое обновит запись.
              </p>
              <Button type="submit" disabled={isGenerating}>
                Сохранить в память
              </Button>
            </div>
            {feedback ? (
              <output aria-live="polite" className="text-sm text-white/70">
                {feedback}
              </output>
            ) : null}
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
