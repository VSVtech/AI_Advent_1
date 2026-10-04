/* oxlint-disable next/no-html-link-for-pages -- Vinext uses ordinary links for standalone pages. */
import { ArrowLeft } from 'lucide-react';
import { RagAnswerComparison } from '@/components/rag-answer-comparison';

export default function RagComparisonPage() {
  return (
    <main className="rag-comparison-page flex min-h-dvh justify-center p-0 sm:p-4">
      <div className="app-frame flex h-auto flex-col overflow-visible sm:h-auto">
        <header className="chat-header flex shrink-0 flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold text-white">
              Сравнение RAG
            </h1>
            <p className="text-xs text-white/45">
              10 вопросов · три режима ответа
            </p>
          </div>
          <a
            href="/"
            className="flex items-center gap-2 text-sm text-white/70 hover:text-white"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />К агентам
          </a>
        </header>
        <RagAnswerComparison />
      </div>
    </main>
  );
}
