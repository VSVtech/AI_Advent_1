// One scheduler run, started by cron every minute (see weather.crontab).
// Each run only does what is due, so a missed or repeated run is harmless.
import { pathToFileURL } from 'node:url';

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import { runWeatherJobsTick } from './weather-jobs.mjs';
import {
  buildDailyReport,
  CITY,
  dataDirectory,
  errorMessage,
  moscowClock,
  readReport,
  readSample,
  readSamples,
  readSchedulerStatus,
  REPORT_HOUR,
  saveReport,
  saveSample,
  saveSchedulerStatus,
} from './weather-store.mjs';

const HOURLY_RETRY_MS = 5 * 60_000;

// Collection goes through the same MCP get_weather tool the chat agent uses.
export async function getWeatherViaMcp(city = CITY) {
  const endpoint = new URL(
    process.env.MCP_SERVER_URL ?? 'http://127.0.0.1:8765/mcp',
  );
  const client = new Client({
    name: 'ai-challenge-weather-tick',
    version: '1.0.0',
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint), {
      timeout: 8_000,
    });
    // get_weather makes two Open-Meteo requests with a 10 s timeout each.
    const result = await client.callTool(
      { name: 'get_weather', arguments: { city } },
      { timeout: 25_000 },
    );
    const text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join(' ');
    if (result.isError) {
      throw new Error(
        `MCP-инструмент погоды вернул ошибку: ${text.slice(0, 300) || 'без описания'}`,
      );
    }
    if (!text) throw new Error('MCP-инструмент погоды вернул пустой ответ');
    return JSON.parse(text);
  } finally {
    await client.close().catch(() => {});
  }
}

async function collectHourlySample({ now, dataDir, fetchWeather, status }) {
  const { date, hour } = moscowClock(now);
  const existing = await readSample(date, hour, dataDir);
  if (existing) return { sample: existing, collected: false, error: null };
  const retryAt = Date.parse(status?.nextHourlyAttemptAt ?? '');
  if (now.getTime() < retryAt) {
    return { sample: null, collected: false, error: null, deferred: true };
  }
  try {
    const sample = await saveSample(await fetchWeather(CITY), now, dataDir);
    return { sample, collected: true, error: null };
  } catch (error) {
    return { sample: null, collected: false, error };
  }
}

async function updateDailyReport({ now, dataDir, sample }) {
  const { date, hour } = moscowClock(now);
  if (hour < REPORT_HOUR) return null;
  const existing = await readReport(date, dataDir);
  // A report made while the 16:00 reading was failing is completed once it
  // arrives within that hour; later readings do not change the report.
  if (
    existing &&
    !(hour === REPORT_HOUR && sample && !existing.hours.includes(REPORT_HOUR))
  ) {
    return null;
  }
  const samples = (await readSamples(date, dataDir)).filter(
    (item) => item.hour <= REPORT_HOUR,
  );
  return saveReport(buildDailyReport(date, samples, now), dataDir);
}

export async function runWeatherTick({
  now = new Date(),
  dataDir = dataDirectory(),
  fetchWeather = getWeatherViaMcp,
} = {}) {
  const previous = await readSchedulerStatus(dataDir);
  const hourly = await collectHourlySample({
    now,
    dataDir,
    fetchWeather,
    status: previous,
  });
  const report = await updateDailyReport({
    now,
    dataDir,
    sample: hourly.sample,
  });
  const jobs = await runWeatherJobsTick({ now, dataDir, fetchWeather });

  let failure = null;
  if (hourly.error) {
    failure = {
      message: errorMessage(hourly.error),
      nextHourlyAttemptAt: new Date(
        now.getTime() + HOURLY_RETRY_MS,
      ).toISOString(),
    };
  } else if (hourly.deferred) {
    failure = {
      message: previous.message ?? 'Замер не получен',
      nextHourlyAttemptAt: previous.nextHourlyAttemptAt,
    };
  }
  await saveSchedulerStatus(
    {
      state: failure ? 'error' : 'ok',
      lastTickAt: now.toISOString(),
      lastSampleAt:
        hourly.sample?.collectedAt ?? previous?.lastSampleAt ?? null,
      ...failure,
    },
    dataDir,
  );
  return {
    sample: hourly.collected ? hourly.sample : null,
    report,
    jobs,
    error: hourly.error,
  };
}

async function main() {
  const now = new Date();
  const log = (message) => console.log(`${now.toISOString()} ${message}`);
  const fail = (message) => {
    console.error(`${now.toISOString()} ${message}`);
    process.exitCode = 1;
  };
  try {
    const { sample, report, jobs, error } = await runWeatherTick({ now });
    if (sample) {
      log(`замер ${sample.date} ${sample.hour}:00 — ${sample.temperatureC} °C`);
    }
    if (report) {
      log(`суточная сводка ${report.date}, замеров: ${report.sampleCount}`);
    }
    for (const job of jobs) {
      const lastError = job.errors.at(-1);
      if (job.status === 'completed') {
        log(`задание ${job.id} завершено, замеров: ${job.samples.length}`);
      } else if (lastError?.at === now.toISOString()) {
        fail(`задание ${job.id}: замер не получен — ${lastError.message}`);
      } else {
        log(`задание ${job.id}: замер №${job.samples.length}`);
      }
    }
    if (error) fail(`Сбор погоды не удался: ${errorMessage(error)}`);
  } catch (error) {
    fail(`Планировщик погоды: ${errorMessage(error)}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
