'use client';

import { ListTodo } from 'lucide-react';
import { type SyntheticEvent, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { MAX_TASK_GOAL_LENGTH, MAX_TASK_TITLE_LENGTH } from '@/lib/task-state';

export function TaskSetup({
  onCreate,
  onCancel,
}: {
  onCreate: (title: string, goal: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const canCreate =
    title.trim().length > 0 &&
    goal.trim().length > 0 &&
    title.length <= MAX_TASK_TITLE_LENGTH &&
    goal.length <= MAX_TASK_GOAL_LENGTH;

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canCreate) onCreate(title.trim(), goal.trim());
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
            <p className="text-xs text-white/40">Шаг 1 · название и цель</p>
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
