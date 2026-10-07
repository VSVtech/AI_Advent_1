'use client';
import { useEffect, useState } from 'react';
import { DEFAULT_MODEL } from '@/lib/chat-constraints';
import { LOCAL_MODEL_PREFIX } from '@/lib/model-provider';

// Comparisons keep their cloud-only catalog; agent creation opts into local models.
export function useAvailableModels(includeLocal = false): {
  models: string[];
  error: string | null;
} {
  const [models, setModels] = useState<string[]>([DEFAULT_MODEL]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const results = await Promise.allSettled([
        fetch('/api/models', { signal: controller.signal }).then(async (r) => {
          if (!r.ok) throw new Error();
          const data = (await r.json()) as { models: string[] };
          if (!Array.isArray(data.models)) throw new Error();
          return data.models.filter((m) => typeof m === 'string');
        }),
        ...(includeLocal
          ? [
              fetch('/api/local-chat', { signal: controller.signal }).then(
                async (r) => {
                  if (!r.ok) throw new Error();
                  const data = (await r.json()) as {
                    models: Array<{ name: string }>;
                  };
                  if (!Array.isArray(data.models)) throw new Error();
                  return data.models.map(
                    (m) => `${LOCAL_MODEL_PREFIX}${m.name}`,
                  );
                },
              ),
            ]
          : []),
      ]);
      if (controller.signal.aborted) return;
      const cloud =
        results[0].status === 'fulfilled' && results[0].value.length
          ? results[0].value
          : [DEFAULT_MODEL];
      const local = results[1]?.status === 'fulfilled' ? results[1].value : [];
      setModels([...new Set([...cloud, ...local])]);
      const warnings = [];
      if (results[0].status === 'rejected')
        warnings.push(
          'Список DeepSeek недоступен; показана модель по умолчанию.',
        );
      if (includeLocal && (results[1]?.status === 'rejected' || !local.length))
        warnings.push(
          'Локальные модели недоступны. Запустите pnpm rag:ollama и откройте настройки заново.',
        );
      setError(warnings.join(' ') || null);
    }
    void load();
    return () => controller.abort();
  }, [includeLocal]);
  return { models, error };
}
