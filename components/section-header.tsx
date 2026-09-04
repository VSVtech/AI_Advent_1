'use client';

import { Sparkles, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatModelLabel } from '@/lib/chat-constraints';

export function SectionHeader({
  title,
  subtitle,
  clearLabel,
  canClear = false,
  onClear,
  model,
  availableModels,
  onModelChange,
  modelDisabled = false,
  modelsError,
}: {
  title: string;
  subtitle: string;
  clearLabel: string;
  canClear?: boolean;
  onClear?: () => void;
  // Model selection is optional: sections without a model to choose (e.g.
  // Comparison, which always runs the default model) render a static badge.
  model?: string;
  availableModels?: string[];
  onModelChange?: (model: string) => void;
  modelDisabled?: boolean;
  modelsError?: string | null;
}) {
  const canSelectModel =
    model !== undefined &&
    availableModels !== undefined &&
    availableModels.length > 0 &&
    onModelChange !== undefined;

  return (
    <header className="chat-header">
      <div className="flex min-w-0 items-center gap-3">
        <span className="brand-mark shrink-0" aria-hidden="true">
          <Sparkles className="size-[18px]" />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold tracking-[-0.01em] text-white">
            {title}
          </h1>
          <p className="truncate text-xs text-white/40">{subtitle}</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {canSelectModel ? (
          <Select
            value={model}
            disabled={modelDisabled}
            onValueChange={(value) => {
              if (typeof value === 'string' && availableModels.includes(value)) {
                onModelChange(value);
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="model-badge-trigger"
              aria-label="Модель"
              title={modelsError ?? undefined}
            >
              <span className="status-dot" aria-hidden="true" />
              <SelectValue>
                {(value: string | null) => {
                  const label = value ? formatModelLabel(value) : 'Модель';
                  return (
                    <>
                      <span className="hidden sm:inline">{label}</span>
                      <span className="sm:hidden">{label.split(' ')[0]}</span>
                    </>
                  );
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="end" className="format-menu">
              {availableModels.map((id) => (
                <SelectItem key={id} value={id} className="format-option">
                  {formatModelLabel(id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Badge className="model-badge" variant="outline">
            <span className="status-dot" aria-hidden="true" />
            <span className="hidden sm:inline">V4 Flash</span>
            <span className="sm:hidden">V4</span>
          </Badge>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="header-action"
          aria-label={clearLabel}
          disabled={!canClear || !onClear}
          onClick={onClear}
        >
          <Trash2 />
        </Button>
      </div>
    </header>
  );
}
