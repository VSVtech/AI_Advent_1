'use client';

import { ArrowUpRight, BrainCircuit, PanelRight, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Agent } from '@/lib/agent';
import type {
  EditableMemoryLayer,
  LongTermMemoryKind,
  MemoryEntry,
} from '@/lib/memory-layers';

const kindLabels: Record<LongTermMemoryKind, string> = {
  profile: 'Профиль',
  decision: 'Решение',
  knowledge: 'Знание',
};

function EntryList({
  entries,
  layer,
  disabled,
  onDelete,
}: {
  entries: MemoryEntry[];
  layer: EditableMemoryLayer;
  disabled: boolean;
  onDelete: (entry: MemoryEntry) => void;
}) {
  if (entries.length === 0) {
    return <p className="text-sm leading-5 text-white/45">Пока нет записей.</p>;
  }

  return (
    <ul className="space-y-2">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="rounded-xl border border-white/8 bg-white/[0.035] px-3 py-2.5"
        >
          {entry.kind ? (
            <p className="mb-1 text-xs font-medium text-emerald-200/70">
              {kindLabels[entry.kind]}
            </p>
          ) : null}
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 break-words text-sm font-medium leading-5 text-white/85">
              {entry.key}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="-mr-1 -mt-1 shrink-0 text-white/45 hover:text-red-200"
              aria-label={`Удалить «${entry.key}» из ${layer === 'working' ? 'рабочей' : 'долговременной'} памяти`}
              disabled={disabled}
              onClick={() => onDelete(entry)}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5 text-white/60">
            {entry.value}
          </p>
        </li>
      ))}
    </ul>
  );
}

type PendingMemoryAction =
  | { type: 'delete-short-term'; key: string }
  | { type: 'delete-entry'; layer: EditableMemoryLayer; entry: MemoryEntry }
  | { type: 'promote'; key: string };

function SectionHeading({
  children,
  count,
}: {
  children: string;
  count?: number;
}) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-white/80">{children}</h3>
      {count !== undefined ? (
        <span className="text-xs tabular-nums text-white/40">{count}</span>
      ) : null}
    </div>
  );
}

function MemoryPanelContents({ agent }: { agent: Agent }) {
  const [pendingAction, setPendingAction] =
    useState<PendingMemoryAction | null>(null);
  const [promotionKind, setPromotionKind] =
    useState<LongTermMemoryKind>('knowledge');
  const [feedback, setFeedback] = useState<string | null>(null);
  const { shortTerm, working, longTerm } = agent.getMemoryLayers();
  const isGenerating = agent.getSnapshot().isGenerating;
  const memoryStatus = agent.getMemoryAnalysisStatus();
  const summary = agent.getActiveBranchSummary();
  const activeBranch = agent
    .getBranches()
    .find((branch) => branch.id === agent.getActiveBranchId());
  const promotionValue =
    pendingAction?.type === 'promote'
      ? shortTerm[pendingAction.key]
      : undefined;
  const existingLongTerm =
    pendingAction?.type === 'promote'
      ? longTerm.find(
          (entry) =>
            entry.key.toLocaleLowerCase() ===
            pendingAction.key.toLocaleLowerCase(),
        )
      : undefined;

  const openAction = (action: PendingMemoryAction) => {
    setPendingAction(action);
    setPromotionKind('knowledge');
    setFeedback(null);
  };

  const confirmAction = () => {
    if (!pendingAction) return;
    const success =
      pendingAction.type === 'delete-short-term'
        ? agent.deleteShortTermFact(pendingAction.key)
        : pendingAction.type === 'delete-entry'
          ? agent.deleteMemoryEntry(pendingAction.layer, pendingAction.entry.id)
          : agent.promoteShortTermFact(pendingAction.key, promotionKind);
    if (!success) {
      setFeedback(
        'Не удалось изменить память. Проверьте, что запись ещё существует и в долговременной памяти есть место.',
      );
      return;
    }
    setPendingAction(null);
    setFeedback(null);
  };

  return (
    <>
      <Tabs defaultValue="session" className="h-full min-h-0 gap-0">
        <div className="shrink-0 border-b border-white/8 px-4 pb-3 pt-4 pr-11 lg:pr-4">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-emerald-300/10 text-emerald-200">
              <BrainCircuit className="size-4" aria-hidden="true" />
            </span>
            <h2 className="text-base font-semibold text-white/90">Память</h2>
          </div>
          <TabsList className="mt-4 h-10 w-full rounded-xl border border-white/8 bg-white/[0.035] p-1">
            <TabsTrigger
              value="session"
              className="min-w-0 text-xs data-active:bg-emerald-300/10 data-active:text-emerald-100"
            >
              Сессионная
            </TabsTrigger>
            <TabsTrigger
              value="long-term"
              className="min-w-0 text-xs data-active:bg-emerald-300/10 data-active:text-emerald-100"
            >
              Долговременная
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          value="session"
          className="min-h-0 overflow-y-auto overscroll-contain px-4 py-4"
        >
          <p className="mb-5 break-words text-sm leading-5 text-white/50">
            {activeBranch ? `${agent.name} · ${activeBranch.name}` : agent.name}
          </p>

          <section className="mb-6" aria-label="Краткосрочная память">
            <SectionHeading count={Object.keys(shortTerm).length}>
              Краткосрочная память
            </SectionHeading>
            <p className="mb-3 text-sm leading-5 text-white/45">
              Важные факты текущего диалога, извлечённые отдельным агентом.
              История сообщений хранится отдельно в чате. Служебные сообщения
              состояния задачи не анализируются.
            </p>
            {memoryStatus.analyzing ? (
              <p className="mb-3 text-xs text-emerald-200/70">
                Анализирую диалог…
              </p>
            ) : null}
            {memoryStatus.error ? (
              <output className="mb-3 block text-xs leading-5 text-amber-200/75">
                Память не обновилась: {memoryStatus.error} Ответ агента
                продолжится без обновления памяти.
              </output>
            ) : null}
            {Object.keys(shortTerm).length ? (
              <ul className="space-y-2">
                {Object.entries(shortTerm).map(([key, value]) => (
                  <li
                    key={key}
                    className="rounded-xl border border-white/8 bg-white/[0.035] px-3 py-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 break-words text-sm font-medium text-white/85">
                        {key}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="-mr-1 -mt-1 shrink-0 text-white/45 hover:text-red-200"
                        aria-label={`Удалить «${key}» из краткосрочной памяти`}
                        disabled={isGenerating}
                        onClick={() =>
                          openAction({ type: 'delete-short-term', key })
                        }
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5 text-white/60">
                      {value}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3 h-8 border-emerald-200/15 bg-transparent text-xs text-emerald-100/75 hover:bg-emerald-300/10 hover:text-emerald-100"
                      disabled={isGenerating}
                      onClick={() => openAction({ type: 'promote', key })}
                    >
                      <ArrowUpRight className="size-3.5" aria-hidden="true" />
                      В долговременную
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm leading-5 text-white/45">
                Пока нет фактов.
              </p>
            )}
          </section>

          <section className="mb-6" aria-label="Рабочая память">
            <SectionHeading count={working.length}>
              Рабочая память
            </SectionHeading>
            <p className="mb-3 text-sm leading-5 text-white/45">
              Заметки по текущей задаче, которые вы сохраняете вручную.
            </p>
            <EntryList
              entries={working}
              layer="working"
              disabled={isGenerating}
              onDelete={(entry) =>
                openAction({ type: 'delete-entry', layer: 'working', entry })
              }
            />
          </section>

          {summary ? (
            <section className="mb-6" aria-label="Сводка веток">
              <SectionHeading>Сводка веток</SectionHeading>
              <p className="whitespace-pre-wrap break-words rounded-xl border border-white/8 bg-white/[0.035] px-3 py-2.5 text-sm leading-5 text-white/65">
                {summary}
              </p>
            </section>
          ) : null}
        </TabsContent>

        <TabsContent
          value="long-term"
          className="min-h-0 overflow-y-auto overscroll-contain px-4 py-4"
        >
          <p className="mb-4 text-sm leading-5 text-white/50">
            Отобранные агентом устойчивые сведения и ваши записи. Общая для всех
            агентов; учитывается в следующих запросах.
          </p>
          <SectionHeading count={longTerm.length}>
            Сохранённые записи
          </SectionHeading>
          <EntryList
            entries={longTerm}
            layer="long-term"
            disabled={isGenerating}
            onDelete={(entry) =>
              openAction({ type: 'delete-entry', layer: 'long-term', entry })
            }
          />
        </TabsContent>
      </Tabs>
      <Dialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingAction(null);
            setFeedback(null);
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="border border-white/10 bg-[#142021] text-white sm:max-w-md"
        >
          <DialogHeader>
            <DialogTitle>
              {pendingAction?.type === 'promote'
                ? 'Перенести в долговременную память'
                : 'Удалить запись из памяти?'}
            </DialogTitle>
            <DialogDescription className="text-white/55">
              {pendingAction?.type === 'promote'
                ? 'Запись будет доступна всем агентам, а из краткосрочной памяти текущего диалога исчезнет.'
                : pendingAction?.type === 'delete-entry' &&
                    pendingAction.layer === 'long-term'
                  ? 'Запись исчезнет из общей памяти всех агентов. История чата не изменится.'
                  : 'Запись исчезнет из памяти текущего диалога или задачи. История чата не изменится.'}
            </DialogDescription>
          </DialogHeader>
          {pendingAction ? (
            <div className="min-w-0 rounded-lg border border-white/10 bg-white/[0.035] p-3 text-sm">
              <p className="break-words font-medium text-white/85">
                {pendingAction.type === 'delete-entry'
                  ? pendingAction.entry.key
                  : pendingAction.key}
              </p>
              <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-white/60">
                {pendingAction.type === 'delete-entry'
                  ? pendingAction.entry.value
                  : shortTerm[pendingAction.key]}
              </p>
            </div>
          ) : null}
          {pendingAction?.type === 'promote' ? (
            <>
              <label className="grid gap-1 text-sm text-white/70">
                Тип записи
                <select
                  value={promotionKind}
                  onChange={(event) =>
                    setPromotionKind(event.target.value as LongTermMemoryKind)
                  }
                  className="min-h-10 rounded-lg border border-white/15 bg-[#10191a] px-3 text-white"
                >
                  {Object.entries(kindLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {existingLongTerm ? (
                <p className="text-sm leading-5 text-amber-200/75">
                  Ключ уже есть в общей памяти. Его значение
                  {existingLongTerm.value === promotionValue
                    ? ' останется тем же, а тип обновится.'
                    : ` «${existingLongTerm.value}» будет заменено.`}
                </p>
              ) : null}
            </>
          ) : null}
          {feedback ? (
            <output className="text-sm leading-5 text-amber-200/75">
              {feedback}
            </output>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPendingAction(null)}
            >
              Отмена
            </Button>
            <Button
              type="button"
              variant={
                pendingAction?.type === 'promote' ? 'default' : 'destructive'
              }
              disabled={
                isGenerating ||
                !pendingAction ||
                (pendingAction.type === 'promote' &&
                  promotionValue === undefined)
              }
              onClick={confirmAction}
            >
              {pendingAction?.type === 'promote'
                ? existingLongTerm
                  ? 'Обновить и перенести'
                  : 'Перенести'
                : 'Удалить'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AgentMemoryPanel({ agent }: { agent: Agent }) {
  return (
    <aside className="memory-panel" aria-label="Панель памяти">
      <MemoryPanelContents agent={agent} />
    </aside>
  );
}

export function AgentMemoryPanelSheet({ agent }: { agent: Agent }) {
  return (
    <Sheet>
      <SheetTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="header-action lg:hidden"
            aria-label="Открыть панель памяти"
          />
        }
      >
        <PanelRight className="size-4" aria-hidden="true" />
      </SheetTrigger>
      <SheetContent
        side="right"
        className="gap-0 border-white/10 bg-[#0d1617] p-0 text-white data-[side=right]:w-[min(92vw,380px)] sm:max-w-[380px] lg:hidden"
      >
        <SheetTitle className="sr-only">Панель памяти</SheetTitle>
        <SheetDescription className="sr-only">
          Сессионная и долговременная память агента
        </SheetDescription>
        <MemoryPanelContents agent={agent} />
      </SheetContent>
    </Sheet>
  );
}
