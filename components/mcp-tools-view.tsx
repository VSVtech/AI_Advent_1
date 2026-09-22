'use client';

import { Cloud, LoaderCircle, RefreshCw, Server, Wrench } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { McpDirectoryResponse, McpToolInfo } from '@/lib/mcp-directory';

function ToolArguments({ schema }: { schema: McpToolInfo['inputSchema'] }) {
  const properties = Object.entries(schema.properties ?? {});
  if (properties.length === 0) {
    return <p className="text-xs text-white/40">Без аргументов</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {properties.map(([name, property]) => (
        <span
          key={name}
          className="rounded-lg border border-white/8 bg-white/[0.035] px-2.5 py-1 font-mono text-xs text-white/60"
          title={property.description}
        >
          {name}
          {schema.required?.includes(name) ? ' *' : ''}
          <span className="text-white/30">: {property.type ?? 'value'}</span>
        </span>
      ))}
    </div>
  );
}

export function McpToolsView() {
  const [directory, setDirectory] = useState<McpDirectoryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [requestFailed, setRequestFailed] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setIsLoading(true);
    setRequestFailed(false);

    try {
      const response = await fetch('/api/mcp', {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('MCP directory request failed');
      const payload = (await response.json()) as McpDirectoryResponse;
      if (!Array.isArray(payload.servers))
        throw new Error('Invalid MCP directory');
      setDirectory(payload);
    } catch {
      if (!controller.signal.aborted) setRequestFailed(true);
    } finally {
      if (!controller.signal.aborted) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(timeoutId);
      requestRef.current?.abort();
    };
  }, [refresh]);

  return (
    <div className="agent-setup">
      <header className="chat-header">
        <div className="flex items-center gap-3">
          <span className="brand-mark" aria-hidden="true">
            <Wrench className="size-[18px]" />
          </span>
          <div>
            <h1 className="text-sm font-semibold text-white">
              MCP Инструменты
            </h1>
            <p className="text-xs text-white/40">
              Подключённые серверы и доступные действия
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-2 text-white/65 hover:bg-white/[0.06] hover:text-white"
          disabled={isLoading}
          onClick={() => void refresh()}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Обновить
        </Button>
      </header>

      <div className="min-h-0 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {requestFailed ? (
            <p
              role="alert"
              className="rounded-xl border border-red-300/15 bg-red-300/5 p-4 text-sm text-red-200"
            >
              Не удалось загрузить список MCP-серверов. Попробуйте обновить
              экран.
            </p>
          ) : null}
          {isLoading && !directory ? (
            <output className="flex items-center gap-2 text-sm text-white/50">
              <LoaderCircle
                className="size-4 animate-spin"
                aria-hidden="true"
              />
              Проверяю MCP-сервер…
            </output>
          ) : null}
          {directory?.servers.map((server) => (
            <section
              key={server.id}
              className="overflow-hidden rounded-2xl border border-white/8 bg-white/[0.025]"
              aria-label={server.name}
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-4 py-4 sm:px-5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-300/10 text-emerald-200">
                    <Server className="size-5" aria-hidden="true" />
                  </span>
                  <div>
                    <h2 className="text-base font-semibold text-white">
                      {server.name}
                    </h2>
                    <p className="flex items-center gap-1.5 text-xs text-white/45">
                      <Cloud className="size-3.5" aria-hidden="true" />
                      ai-vps · Streamable HTTP
                    </p>
                  </div>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    server.status === 'connected'
                      ? 'bg-emerald-300/10 text-emerald-200'
                      : 'bg-amber-300/10 text-amber-200'
                  }`}
                >
                  {server.status === 'connected' ? 'Подключён' : 'Недоступен'}
                </span>
              </div>

              {server.status === 'connected' ? (
                server.tools.length > 0 ? (
                  <div className="divide-y divide-white/7">
                    {server.tools.map((tool) => (
                      <div
                        key={tool.name}
                        className="space-y-2.5 px-4 py-4 sm:px-5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Wrench
                            className="size-4 text-emerald-200/75"
                            aria-hidden="true"
                          />
                          <h3 className="font-mono text-sm font-medium text-white/85">
                            {tool.name}
                          </h3>
                        </div>
                        {tool.description ? (
                          <p className="text-sm leading-6 text-white/55">
                            {tool.description}
                          </p>
                        ) : null}
                        <ToolArguments schema={tool.inputSchema} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="px-5 py-6 text-sm text-white/50">
                    Сервер подключён, но инструментов пока нет.
                  </p>
                )
              ) : (
                <div className="space-y-2 px-5 py-6 text-sm leading-6 text-white/55">
                  <p>Не удалось связаться с MCP-сервером на капсуле.</p>
                  <p>Проверьте SSH-туннель и нажмите «Обновить».</p>
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
