import { isValidModel } from '@/lib/chat-constraints';
import { DEEPSEEK_MODEL, jsonError } from '@/lib/server/deepseek';
import {
  composeWeatherJobReport,
  readDailyWeather,
  readWeatherJobs,
  type WeatherJobSummary,
} from '@/lib/server/weather-mcp';
import {
  MAX_TRACKED_WEATHER_JOBS,
  type WeatherJobResult,
} from '@/lib/weather-jobs';
import type { WeatherSummaryResponse } from '@/lib/weather-summary';

const NO_STORE = { 'Cache-Control': 'no-store' };

function unavailable(): Response {
  return jsonError(503, {
    code: 'weather_mcp_unavailable',
    message: 'MCP-сервер со сводкой погоды недоступен.',
  });
}

// Latest daily summary made by the scheduler on the MCP server.
export async function GET(request: Request): Promise<Response> {
  let daily;
  try {
    daily = await readDailyWeather(request.signal);
  } catch {
    return unavailable();
  }
  const body: WeatherSummaryResponse = daily.report
    ? { status: 'ready', summary: daily.report, scheduler: daily.scheduler }
    : { status: 'pending', summary: null, scheduler: daily.scheduler };
  return Response.json(body, { headers: NO_STORE });
}

// Status of jobs scheduled by the chat agent; finished jobs get the final text.
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    jobIds?: unknown;
    model?: unknown;
  } | null;
  const jobIds = body?.jobIds;
  if (
    !Array.isArray(jobIds) ||
    jobIds.length === 0 ||
    jobIds.length > MAX_TRACKED_WEATHER_JOBS ||
    !jobIds.every(
      (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(id),
    )
  ) {
    return jsonError(400, {
      code: 'invalid_weather_jobs',
      message: `Передайте от 1 до ${MAX_TRACKED_WEATHER_JOBS} идентификаторов заданий.`,
    });
  }
  const model = body?.model ?? DEEPSEEK_MODEL;
  if (!isValidModel(model)) {
    return jsonError(400, {
      code: 'invalid_model',
      message: 'Некорректная модель.',
    });
  }

  let summaries: WeatherJobSummary[];
  try {
    summaries = await readWeatherJobs(jobIds as string[], request.signal);
  } catch {
    return unavailable();
  }
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() || null;
  const jobs: WeatherJobResult[] = [];
  for (const summary of summaries) {
    if (summary.status === 'not_found') {
      jobs.push({
        id: summary.jobId,
        status: 'not_found',
        content: `Не удалось получить результат сбора погоды: задание ${summary.jobId} не найдено на MCP-сервере.`,
      });
    } else if (summary.status === 'running') {
      jobs.push({ id: summary.jobId, status: 'running' });
    } else {
      jobs.push({
        id: summary.jobId,
        status: 'completed',
        content: await composeWeatherJobReport(summary, {
          apiKey,
          model,
          signal: request.signal,
        }),
      });
    }
  }
  return Response.json({ jobs }, { headers: NO_STORE });
}
