'use client';

import { Sparkles, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function SectionHeader({
  title,
  subtitle,
  clearLabel,
  canClear = false,
  onClear,
}: {
  title: string;
  subtitle: string;
  clearLabel: string;
  canClear?: boolean;
  onClear?: () => void;
}) {
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
        <Badge className="model-badge" variant="outline">
          <span className="status-dot" aria-hidden="true" />
          <span className="hidden sm:inline">V4 Flash</span>
          <span className="sm:hidden">V4</span>
        </Badge>
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
