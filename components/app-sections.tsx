'use client';

import { Columns2, Gauge, MessageSquare, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';

import { Comparison } from '@/components/comparison';
import { ModelBenchmark } from '@/components/model-benchmark';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useIsMobile } from '@/hooks/use-mobile';

export type AppSection = 'chat' | 'comparison' | 'benchmark';

const sections = [
  { value: 'chat', label: 'Чат', icon: MessageSquare },
  { value: 'comparison', label: 'Сравнение', icon: Columns2 },
  { value: 'benchmark', label: 'Бенчмарк', icon: Gauge },
] as const;

export function AppSections({
  activeSection,
  onSectionChange,
  children,
}: {
  activeSection: AppSection;
  onSectionChange: (section: AppSection) => void;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();

  return (
    <Tabs
      value={activeSection}
      onValueChange={(value) => {
        if (value === 'chat' || value === 'comparison' || value === 'benchmark') {
          onSectionChange(value);
        }
      }}
      orientation={isMobile ? 'horizontal' : 'vertical'}
      className={`app-frame flex-col gap-0 md:flex-row${activeSection === 'chat' ? '' : ' sm:max-w-none'}`}
    >
      <aside className="app-sidebar" aria-label="Меню разделов">
        <div className="hidden h-[68px] items-center gap-2.5 px-4 md:flex">
          <span className="brand-mark" aria-hidden="true">
            <Sparkles className="size-[18px]" />
          </span>
          <span className="text-sm font-semibold tracking-[-0.01em] text-white">
            DeepSeek
          </span>
        </div>
        <TabsList
          aria-label="Разделы"
          className="w-full justify-start gap-1 rounded-none bg-transparent p-2 md:flex-col md:items-stretch md:p-3"
        >
          {sections.map(({ value, label, icon: Icon }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="h-10 flex-1 justify-start gap-2.5 rounded-xl px-3 text-xs text-white/50 hover:bg-white/[0.045] hover:text-white/80 data-active:border-emerald-300/15 data-active:bg-emerald-300/10 data-active:text-emerald-200 md:flex-none dark:text-white/50 dark:data-active:border-emerald-300/15 dark:data-active:bg-emerald-300/10 dark:data-active:text-emerald-200"
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </aside>

      <TabsContent value="chat" keepMounted className="section-panel">
        {children}
      </TabsContent>
      <TabsContent value="comparison" keepMounted className="section-panel">
        <Comparison />
      </TabsContent>
      <TabsContent value="benchmark" keepMounted className="section-panel">
        <ModelBenchmark />
      </TabsContent>
    </Tabs>
  );
}
