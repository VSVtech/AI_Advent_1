'use client';

import {
  ArrowRight,
  Cloud,
  CloudRain,
  LoaderCircle,
  RefreshCw,
  Server,
  Thermometer,
  Workflow,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { AGENT_SKILLS } from '@/lib/agent-skills';
import type { McpDirectoryResponse, McpToolInfo } from '@/lib/mcp-directory';
import {
  WEATHER_SUMMARY_URL,
  type WeatherSummaryResponse,
} from '@/lib/weather-summary';

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
  const [weatherSummary, setWeatherSummary] =
    useState<WeatherSummaryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [requestFailed, setRequestFailed] = useState(false);
  const [summaryFailed, setSummaryFailed] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setIsLoading(true);
    setRequestFailed(false);

    try {
      const [directoryResult, summaryResult] = await Promise.allSettled([
        fetch('/api/mcp', {
          cache: 'no-store',
          signal: controller.signal,
        }),
        fetch(WEATHER_SUMMARY_URL, {
          cache: 'no-store',
          signal: controller.signal,
        }),
      ]);
      if (controller.signal.aborted) return;
      if (directoryResult.status === 'fulfilled' && directoryResult.value.ok) {
        const payload =
          (await directoryResult.value.json()) as McpDirectoryResponse;
        if (!Array.isArray(payload.servers))
          throw new Error('Invalid MCP directory');
        setDirectory(payload);
      } else {
        setRequestFailed(true);
      }
      if (summaryResult.status === 'fulfilled' && summaryResult.value.ok) {
        const payload =
          (await summaryResult.value.json()) as WeatherSummaryResponse;
        if (payload.status !== 'ready' && payload.status !== 'pending') {
          throw new Error('Invalid weather summary');
        }
        setWeatherSummary(payload);
        setSummaryFailed(false);
      } else {
        setSummaryFailed(true);
      }
    } catch {
      if (!controller.signal.aborted) setRequestFailed(true);
    } finally {
      if (!controller.signal.aborted) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void refresh(), 0);
    const intervalId = window.setInterval(() => void refresh(), 60_000);
    return () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
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
          <section
            className="rounded-2xl border border-white/8 bg-white/[0.025] p-4 sm:p-5"
            aria-label="Погодная сводка"
          >
            <div className="mb-3 flex items-center gap-2 text-emerald-200">
              <Thermometer className="size-5" aria-hidden="true" />
              <h2 className="text-base font-semibold text-white">
                Погода за день · Москва
              </h2>
            </div>
            {weatherSummary?.status === 'ready' ? (
              <div className="space-y-2 text-sm text-white/65">
                <p className="text-lg font-medium text-white">
                  {new Intl.DateTimeFormat('ru-RU', {
                    day: 'numeric',
                    month: 'long',
                    timeZone: 'Europe/Moscow',
                  }).format(
                    new Date(`${weatherSummary.summary.date}T12:00:00+03:00`),
                  )}
                  {weatherSummary.summary.minTemperatureC === null ||
                  weatherSummary.summary.maxTemperatureC === null
                    ? ' · нет замеров'
                    : ` · ${weatherSummary.summary.minTemperatureC.toLocaleString('ru-RU')}…${weatherSummary.summary.maxTemperatureC.toLocaleString('ru-RU')} °C`}
                </p>
                <p className="flex items-center gap-2">
                  <CloudRain className="size-4" aria-hidden="true" />
                  Дождь:{' '}
                  {weatherSummary.summary.rainObserved === null
                    ? 'нет данных'
                    : weatherSummary.summary.rainObserved
                      ? 'был'
                      : 'не зафиксирован'}
                </p>
                <p className="text-white/40">
                  {weatherSummary.summary.sampleCount} часовых замеров · сводка
                  формируется в 16:00 МСК
                </p>
              </div>
            ) : summaryFailed ? (
              <p className="text-sm text-amber-200">
                Сводка недоступна: MCP-сервер капсулы не отвечает.
              </p>
            ) : (
              <p className="text-sm text-white/50">
                Пока нет сводки. Первый отчёт появится после 16:00 МСК.
              </p>
            )}
            {weatherSummary?.scheduler?.state === 'error' ? (
              <output className="mt-3 block text-sm text-amber-200">
                Новый замер через MCP пока не получен. Планировщик (cron)
                повторит попытку.
              </output>
            ) : weatherSummary?.scheduler?.lastSampleAt ? (
              <p className="mt-3 text-xs text-white/40">
                Последний замер:{' '}
                {new Intl.DateTimeFormat('ru-RU', {
                  dateStyle: 'short',
                  timeStyle: 'short',
                  timeZone: 'Europe/Moscow',
                }).format(new Date(weatherSummary.scheduler.lastSampleAt))}{' '}
                МСК
              </p>
            ) : null}
          </section>
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
          <section
            className="rounded-2xl border border-white/8 bg-white/[0.025] p-4 sm:p-5"
            aria-label="Скиллы агента"
          >
            <div className="mb-3 flex items-center gap-2 text-emerald-200">
              <Workflow className="size-5" aria-hidden="true" />
              <h2 className="text-base font-semibold text-white">
                Скиллы агента
              </h2>
            </div>
            <div className="space-y-4">
              {AGENT_SKILLS.map((skill) => {
                const connectedServers =
                  directory?.servers.filter(
                    (server) => server.status === 'connected',
                  ) ?? [];
                const ready = skill.tools.every((tool) =>
                  connectedServers.some((server) =>
                    server.tools.some((item) => item.name === tool),
                  ),
                );
                // An unreachable server is not the same as missing tools.
                const status = ready
                  ? 'Готов'
                  : connectedServers.length > 0
                    ? 'Нет инструментов на сервере'
                    : isLoading
                      ? 'Проверяю…'
                      : 'MCP недоступен';
                return (
                  <div key={skill.id} className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-medium text-white/85">
                        {skill.name}
                      </h3>
                      <span
                        className={`rounded-full px-3 py-1 text-xs font-medium ${
                          ready
                            ? 'bg-emerald-300/10 text-emerald-200'
                            : 'bg-amber-300/10 text-amber-200'
                        }`}
                      >
                        {status}
                      </span>
                    </div>
                    <p className="text-sm leading-6 text-white/55">
                      {skill.description}
                    </p>
                    <p className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-white/60">
                      {skill.tools.map((tool, index) => (
                        <span key={tool} className="flex items-center gap-1.5">
                          {index > 0 ? (
                            <ArrowRight
                              className="size-3.5 text-white/35"
                              aria-label="затем"
                            />
                          ) : null}
                          {tool}
                        </span>
                      ))}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
