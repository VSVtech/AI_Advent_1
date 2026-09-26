import { afterEach, expect, test, vi } from 'vitest';

import { Agent, createDefaultAgentConfig } from '@/lib/agent';
import {
  AGENT_SESSIONS_STORAGE_KEY,
  deserializeAgentSessions,
  saveAgentSessions,
} from '@/lib/agent-storage';
import type { ChatRequest } from '@/lib/chat-types';

afterEach(() => {
  vi.unstubAllGlobals();
});

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

const REPORT =
  '### Замеры погоды: Москва\n\n| Время | Температура |\n|---|---|';

// /api/chat answers like the MCP tool loop after schedule_weather_collection.
function stubApi(weatherStatuses: Array<'running' | 'completed'>) {
  const weatherRequests: string[][] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url === '/api/chat') {
      const request = JSON.parse(init.body as string) as ChatRequest;
      const content = request.messages[0]?.content;
      if (
        typeof content === 'string' &&
        content.startsWith('Ты отдельный агент управления памятью')
      ) {
        return sseResponse([
          `event: delta\ndata: ${JSON.stringify({ content: '{"shortTerm":{},"longTerm":[]}' })}\n\n`,
          'event: done\ndata: {"finishReason":"stop"}\n\n',
        ]);
      }
      return sseResponse([
        `event: delta\ndata: ${JSON.stringify({ content: 'Запустила сбор погоды.' })}\n\n`,
        'event: done\ndata: {"finishReason":"stop","mcpTools":["schedule_weather_collection"],"weatherJobId":"job-1"}\n\n',
      ]);
    }
    if (url === '/api/weather') {
      const { jobIds } = JSON.parse(init.body as string) as {
        jobIds: string[];
      };
      weatherRequests.push(jobIds);
      const status = weatherStatuses.shift() ?? 'completed';
      return Response.json({
        jobs: [
          status === 'running'
            ? { id: 'job-1', status }
            : { id: 'job-1', status, content: REPORT },
        ],
      });
    }
    throw new Error(`Неожиданный запрос: ${url}`);
  });
  return weatherRequests;
}

async function agentWithScheduledJob() {
  const agent = new Agent(createDefaultAgentConfig());
  await agent.sendMessage('Собирай погоду каждые 2 минуты в течение 20 минут');
  return agent;
}

test('агент запоминает jobId из ответа и один раз добавляет итог в тот же чат', async () => {
  const weatherRequests = stubApi(['running', 'completed']);
  const agent = await agentWithScheduledJob();
  expect(agent.getSnapshot().messages[1]).toMatchObject({
    role: 'assistant',
    content: 'Запустила сбор погоды.',
    mcpTools: ['schedule_weather_collection'],
    weatherJobId: 'job-1',
  });

  await agent.syncWeatherJobs();
  expect(agent.getSnapshot().messages).toHaveLength(2);
  await agent.syncWeatherJobs();
  await agent.syncWeatherJobs();

  expect(weatherRequests).toEqual([['job-1'], ['job-1']]);
  expect(agent.getSnapshot().messages).toHaveLength(3);
  expect(agent.getSnapshot().messages[2]).toMatchObject({
    role: 'assistant',
    content: REPORT,
    weatherJobId: 'job-1',
    weatherJobResult: true,
  });
});

test('итог приходит и после перезагрузки вкладки, но не дублируется', async () => {
  const weatherRequests = stubApi(['completed']);
  const agent = await agentWithScheduledJob();
  const storage = new Map<string, string>();
  const writer = {
    setItem: (key: string, value: string) => void storage.set(key, value),
  };

  saveAgentSessions(writer, [agent], agent.id);
  const reopened = deserializeAgentSessions(
    storage.get(AGENT_SESSIONS_STORAGE_KEY) ?? null,
  ).agents[0];
  expect(reopened.getSnapshot().messages[1].weatherJobId).toBe('job-1');

  await reopened.syncWeatherJobs();
  expect(reopened.getSnapshot().messages).toHaveLength(3);

  saveAgentSessions(writer, [reopened], reopened.id);
  const reopenedAgain = deserializeAgentSessions(
    storage.get(AGENT_SESSIONS_STORAGE_KEY) ?? null,
  ).agents[0];
  expect(reopenedAgain.getSnapshot().messages[2]).toMatchObject({
    weatherJobId: 'job-1',
    weatherJobResult: true,
  });
  await reopenedAgain.syncWeatherJobs();
  expect(reopenedAgain.getSnapshot().messages).toHaveLength(3);
  expect(weatherRequests).toHaveLength(1);
});

test('без отслеживаемых заданий агент не обращается к /api/weather', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await new Agent(createDefaultAgentConfig()).syncWeatherJobs();
  expect(fetchMock).not.toHaveBeenCalled();
});
