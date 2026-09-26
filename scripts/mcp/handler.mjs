import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from '@modelcontextprotocol/server';

import { getCurrentWeather } from './weather.mjs';
import {
  createWeatherJob,
  describeWeatherJob,
  isJobId,
  JOB_LIMITS,
  readWeatherJob,
} from './weather-jobs.mjs';
import {
  CITY,
  dataDirectory,
  errorMessage,
  isReportDate,
  readLatestReport,
  readReport,
  readSchedulerStatus,
  REPORT_HOUR,
} from './weather-store.mjs';

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function createWeatherMcpHandler({
  dataDir = dataDirectory(),
  getWeather = getCurrentWeather,
} = {}) {
  return createMcpHandler(() => {
    const mcp = new McpServer({ name: 'ai-challenge-mcp', version: '1.1.0' });

    mcp.registerTool(
      'ping',
      { description: 'Проверить доступность MCP-сервера' },
      async () => ({ content: [{ type: 'text', text: 'pong' }] }),
    );
    mcp.registerTool(
      'server_time',
      { description: 'Получить текущее время сервера в ISO 8601' },
      async () => ({
        content: [{ type: 'text', text: new Date().toISOString() }],
      }),
    );
    mcp.registerTool(
      'get_weather',
      {
        description:
          'Получить текущую погоду в указанном городе через Open-Meteo',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            city: {
              type: 'string',
              minLength: 2,
              maxLength: 120,
              description:
                'Название города, при необходимости с указанием страны',
            },
          },
          required: ['city'],
          additionalProperties: false,
        }),
      },
      async ({ city }) => {
        try {
          return textResult(await getWeather(city));
        } catch (error) {
          return errorResult(errorMessage(error, 'Не удалось получить погоду'));
        }
      },
    );
    mcp.registerTool(
      'schedule_weather_collection',
      {
        description:
          'Запланировать периодический сбор текущей погоды на MCP-сервере: ' +
          'замер каждые intervalMinutes минут в течение durationMinutes минут. ' +
          'Замеры по расписанию выполняет планировщик сервера (cron) и сохраняет в JSON. ' +
          'Возвращает jobId; результат с агрегатами отдаёт get_weather_summary. ' +
          'Используй, когда пользователь просит регулярно собирать или отслеживать погоду.',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            city: {
              type: 'string',
              minLength: 2,
              maxLength: 120,
              description: `Город; если пользователь его не назвал — ${CITY}`,
            },
            intervalMinutes: {
              type: 'integer',
              minimum: JOB_LIMITS.minIntervalMinutes,
              maximum: JOB_LIMITS.maxIntervalMinutes,
              description: 'Интервал между замерами, минуты',
            },
            durationMinutes: {
              type: 'integer',
              minimum: JOB_LIMITS.minDurationMinutes,
              maximum: JOB_LIMITS.maxDurationMinutes,
              description: 'Общая длительность сбора, минуты',
            },
          },
          required: ['intervalMinutes', 'durationMinutes'],
          additionalProperties: false,
        }),
      },
      async (args) => {
        try {
          const job = await createWeatherJob(args, { dataDir });
          return textResult({
            jobId: job.id,
            status: job.status,
            city: job.city,
            intervalMinutes: job.intervalMinutes,
            durationMinutes: job.durationMinutes,
            startedAt: job.startedAt,
            endsAt: job.endsAt,
            expectedSampleCount: Math.ceil(
              job.durationMinutes / job.intervalMinutes,
            ),
            note: 'Первый замер — в течение минуты: планировщик запускается раз в минуту.',
          });
        } catch (error) {
          return errorResult(
            errorMessage(error, 'Не удалось запланировать сбор'),
          );
        }
      },
    );
    mcp.registerTool(
      'get_weather_summary',
      {
        description:
          'Получить агрегированный результат сбора погоды. С jobId — статус ' +
          'задания из schedule_weather_collection, его замеры, диапазон температур ' +
          'и признак дождя. С date (ГГГГ-ММ-ДД) — суточную сводку по Москве, ' +
          `которую планировщик формирует в ${REPORT_HOUR}:00 МСК из ежечасных замеров. ` +
          'Без аргументов — последнюю суточную сводку и состояние планировщика.',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            jobId: {
              type: 'string',
              pattern: '^[a-zA-Z0-9_-]{1,100}$',
              description: 'Идентификатор задания сбора',
            },
            date: {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
              description: 'Дата суточной сводки, ГГГГ-ММ-ДД',
            },
          },
          additionalProperties: false,
        }),
      },
      async ({ jobId, date } = {}) => {
        if (jobId !== undefined && date !== undefined) {
          return errorResult('Укажите либо jobId, либо date.');
        }
        if (jobId !== undefined && !isJobId(jobId)) {
          return errorResult('Некорректный jobId.');
        }
        if (date !== undefined && !isReportDate(date)) {
          return errorResult('Дата должна быть в формате ГГГГ-ММ-ДД.');
        }
        try {
          if (jobId !== undefined) {
            const job = await readWeatherJob(jobId, dataDir);
            return textResult(
              job
                ? describeWeatherJob(job)
                : { kind: 'job', jobId, status: 'not_found' },
            );
          }
          const [report, scheduler] = await Promise.all([
            date === undefined
              ? readLatestReport(dataDir)
              : readReport(date, dataDir),
            readSchedulerStatus(dataDir),
          ]);
          return textResult({
            kind: 'daily',
            city: CITY,
            reportHour: REPORT_HOUR,
            report,
            scheduler,
          });
        } catch (error) {
          return errorResult(
            errorMessage(error, 'Не удалось прочитать сводку погоды'),
          );
        }
      },
    );

    return mcp;
  });
}
