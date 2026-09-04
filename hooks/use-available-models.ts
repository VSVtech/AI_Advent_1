'use client';

import { useEffect, useState } from 'react';

import { DEFAULT_MODEL } from '@/lib/chat-constraints';
import type { ModelsResponsePayload } from '@/lib/chat-types';

// Shared by the chat header (single-model picker) and the model benchmark
// (runs every returned model), so both reflect the same token's actual
// access rather than a hardcoded list.
export function useAvailableModels(): {
  models: string[];
  error: string | null;
} {
  const [models, setModels] = useState<string[]>([DEFAULT_MODEL]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void fetch('/api/models', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('models_unavailable');
        return response.json() as Promise<ModelsResponsePayload>;
      })
      .then((payload) => {
        if (!Array.isArray(payload.models) || payload.models.length === 0) {
          throw new Error('models_unavailable');
        }
        setModels(payload.models);
        setError(null);
      })
      .catch((caughtError) => {
        if (controller.signal.aborted) return;
        setError(
          'Не удалось загрузить список моделей. Доступна модель по умолчанию.',
        );
        void caughtError;
      });

    return () => controller.abort();
  }, []);

  return { models, error };
}
