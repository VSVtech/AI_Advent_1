'use client';

import { ListTodo, Plus, X } from 'lucide-react';
import { type SyntheticEvent, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  MAX_TASK_GOAL_LENGTH,
  MAX_TASK_INVARIANT_LENGTH,
  MAX_TASK_INVARIANTS,
  MAX_TASK_TITLE_LENGTH,
  normalizeTaskInvariants,
} from '@/lib/task-state';

export function TaskSetup({
  onCreate,
  onCancel,
}: {
  onCreate: (title: string, goal: string, invariants: string[]) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [invariants, setInvariants] = useState<string[]>([]);
  const [invariantDraft, setInvariantDraft] = useState('');
  const pendingInvariant = invariantDraft.trim();
  const canAddInvariant =
    pendingInvariant.length > 0 &&
    normalizeTaskInvariants([...invariants, pendingInvariant]) !== null;
  const canCreate =
    title.trim().length > 0 &&
    goal.trim().length > 0 &&
    title.length <= MAX_TASK_TITLE_LENGTH &&
    goal.length <= MAX_TASK_GOAL_LENGTH &&
    (!pendingInvariant || canAddInvariant);

  const addInvariant = () => {
    if (!canAddInvariant) return;
    setInvariants((current) => [...current, pendingInvariant]);
    setInvariantDraft('');
  };

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canCreate) {
      onCreate(
        title.trim(),
        goal.trim(),
        canAddInvariant ? [...invariants, pendingInvariant] : invariants,
      );
    }
  };

  return (
    <div className="agent-setup">
      <header className="chat-header shrink-0">
        <div className="flex min-w-0 items-center gap-3">
          <span className="brand-mark shrink-0" aria-hidden="true">
            <ListTodo className="size-[18px]" />
          </span>
          <div>
            <h1 className="text-sm font-semibold text-white">Новая задача</h1>
            <p className="text-xs text-white/40">
              Название, цель и ограничения
            </p>
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Отмена
        </Button>
      </header>

      <form className="agent-setup-form" onSubmit={handleSubmit}>
        <div className="agent-setup-field">
          <label className="format-label" htmlFor="new-task-title">
            Название задачи
          </label>
          <Input
            id="new-task-title"
            value={title}
            maxLength={MAX_TASK_TITLE_LENGTH}
            placeholder="Например: подготовить техническое задание"
            className="agent-setup-input"
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div className="agent-setup-field">
          <label className="format-label" htmlFor="new-task-goal">
            Цель задачи
          </label>
          <Textarea
            id="new-task-goal"
            value={goal}
            maxLength={MAX_TASK_GOAL_LENGTH}
            placeholder="Опишите результат, которого нужно добиться"
            className="agent-setup-input min-h-32"
            onChange={(event) => setGoal(event.target.value)}
          />
        </div>
        <div className="agent-setup-field">
          <label className="format-label" htmlFor="new-task-invariant">
            Инварианты задачи
          </label>
          <p className="text-xs leading-5 text-white/45">
            Неизменяемые ограничения: архитектура, стек, решения или
            бизнес-правила. Изначально список пуст; сообщения в чате его не
            меняют.
          </p>
          <div className="flex gap-2">
            <Input
              id="new-task-invariant"
              value={invariantDraft}
              maxLength={MAX_TASK_INVARIANT_LENGTH}
              placeholder="Например: использовать только PostgreSQL"
              className="agent-setup-input min-w-0 flex-1"
              onChange={(event) => setInvariantDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addInvariant();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!canAddInvariant}
              onClick={addInvariant}
            >
              <Plus className="size-4" aria-hidden="true" />
              Добавить
            </Button>
          </div>
          {invariants.length ? (
            <ul className="space-y-2" aria-label="Добавленные инварианты">
              {invariants.map((invariant, index) => (
                <li
                  key={`${invariant}-${index}`}
                  className="flex items-start justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/75"
                >
                  <span className="min-w-0 break-words">{invariant}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0"
                    aria-label={`Убрать инвариант: ${invariant}`}
                    onClick={() =>
                      setInvariants((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {invariants.length === MAX_TASK_INVARIANTS ? (
            <p className="text-xs text-white/45">
              Максимум {MAX_TASK_INVARIANTS} инвариантов.
            </p>
          ) : null}
        </div>
        <p className="text-sm leading-6 text-white/50">
          Для задачи создаётся отдельный диалог со стандартными настройками
          агента. Первый этап — planning. После каждого этапа агент предложит
          следующее действие; переход подтверждается ответом в диалоге.
        </p>
        <div className="agent-setup-actions">
          <Button type="submit" disabled={!canCreate}>
            Создать задачу
          </Button>
        </div>
      </form>
    </div>
  );
}
