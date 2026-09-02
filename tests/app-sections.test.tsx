import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppSections, type AppSection } from '@/components/app-sections';
import { useIsMobile } from '@/hooks/use-mobile';

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

function renderSections(activeSection: AppSection) {
  return renderToStaticMarkup(
    <AppSections activeSection={activeSection} onSectionChange={() => {}}>
      <textarea aria-label="Черновик" defaultValue="Черновик сообщения" />
    </AppSections>,
  );
}

beforeEach(() => {
  vi.mocked(useIsMobile).mockReturnValue(false);
});

describe('меню разделов', () => {
  it.each<AppSection>(['chat', 'comparison'])(
    'показывает выбранный раздел %s и сохраняет содержимое чата смонтированным',
    (activeSection) => {
      const markup = renderSections(activeSection);
      const tabs =
        markup.match(/<button\b[^>]*role="tab"[^>]*>[\s\S]*?<\/button>/g) ?? [];
      const panels =
        markup.match(/<div\b[^>]*data-slot="tabs-content"[^>]*>/g) ?? [];

      expect(tabs).toHaveLength(2);
      expect(tabs.find((tab) => tab.endsWith('Чат</button>'))).toContain(
        `aria-selected="${activeSection === 'chat'}"`,
      );
      expect(tabs.find((tab) => tab.endsWith('Сравнение</button>'))).toContain(
        `aria-selected="${activeSection === 'comparison'}"`,
      );
      expect(panels).toHaveLength(2);
      const visibleIndex = activeSection === 'chat' ? 0 : 1;
      expect(panels[visibleIndex]).not.toContain(' hidden=');
      expect(panels[1 - visibleIndex]).toContain(' hidden=');
      expect(panels[1 - visibleIndex]).toContain(' inert=');
      expect(markup).toContain('Черновик сообщения</textarea>');
      expect(markup).toContain('aria-label="Пять чатов для сравнения"');
    },
  );

  it('сохраняет оформление шапки сравнения с новым заголовком и подписью', () => {
    const markup = renderSections('comparison');
    const header = markup.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0];

    expect(header).toContain('>Сравнение</h1>');
    expect(header).toContain(
      '>сравнение ответов для разных системных промптов</p>',
    );
    expect(header).toContain('lucide-sparkles');
    expect(header).toContain('V4 Flash');
    expect(header).toContain('aria-label="Очистить сравнение"');
    expect(header).toContain('disabled=""');
  });

  it('использует вертикальную навигацию для меню слева', () => {
    expect(renderSections('chat')).toContain('aria-orientation="vertical"');
  });

  it('использует горизонтальную навигацию на узких экранах', () => {
    vi.mocked(useIsMobile).mockReturnValue(true);

    const markup = renderSections('chat');
    const tabList = markup.match(/<div\b[^>]*role="tablist"[^>]*>/)?.[0];
    expect(tabList).toContain('data-orientation="horizontal"');
    // Horizontal is the implicit ARIA orientation; Base UI omits the attribute.
    expect(tabList).not.toContain('aria-orientation="vertical"');
  });
});
