import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  aggregateReadings,
  CITY,
  dataDirectory,
  errorMessage,
  readJson,
  readingFromWeather,
  writeJsonAtomically,
} from './weather-store.mjs';

export const JOB_LIMITS = Object.freeze({
  minIntervalMinutes: 1,
  maxIntervalMinutes: 60,
  minDurationMinutes: 2,
  maxDurationMinutes: 120,
  maxSamples: 61,
});
const JOB_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/u;

function jobPath(dataDir, id) {
  return join(dataDir, 'jobs', `${id}.json`);
}

export function isJobId(value) {
  return typeof value === 'string' && JOB_ID_PATTERN.test(value);
}

export function validateJobRequest(value) {
  if (!value || typeof value !== 'object') return null;
  const { city = CITY, intervalMinutes, durationMinutes } = value;
  if (
    typeof city !== 'string' ||
    city.trim().length < 2 ||
    city.trim().length > 120 ||
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < JOB_LIMITS.minIntervalMinutes ||
    intervalMinutes > JOB_LIMITS.maxIntervalMinutes ||
    !Number.isInteger(durationMinutes) ||
    durationMinutes < JOB_LIMITS.minDurationMinutes ||
    durationMinutes > JOB_LIMITS.maxDurationMinutes ||
    Math.ceil(durationMinutes / intervalMinutes) > JOB_LIMITS.maxSamples
  ) {
    return null;
  }
  return { city: city.trim(), intervalMinutes, durationMinutes };
}

export async function readWeatherJob(id, dataDir = dataDirectory()) {
  if (!isJobId(id)) return null;
  return readJson(jobPath(dataDir, id));
}

export async function listWeatherJobs(dataDir = dataDirectory()) {
  let names;
  try {
    names = await readdir(join(dataDir, 'jobs'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const jobs = await Promise.all(
    names
      .filter((name) => /^[a-zA-Z0-9_-]{1,100}\.json$/u.test(name))
      .map((name) => readJson(join(dataDir, 'jobs', name))),
  );
  return jobs.filter((job) => job?.schemaVersion === 1);
}

export async function saveWeatherJob(job, dataDir = dataDirectory()) {
  await writeJsonAtomically(jobPath(dataDir, job.id), job);
  return job;
}

export async function createWeatherJob(
  input,
  { now = new Date(), dataDir = dataDirectory() } = {},
) {
  const request = validateJobRequest(input);
  if (!request) {
    throw new Error(
      `Некорректные параметры сбора: интервал ${JOB_LIMITS.minIntervalMinutes}–${JOB_LIMITS.maxIntervalMinutes} мин., длительность ${JOB_LIMITS.minDurationMinutes}–${JOB_LIMITS.maxDurationMinutes} мин., не более ${JOB_LIMITS.maxSamples} замера.`,
    );
  }
  const jobs = await listWeatherJobs(dataDir);
  if (jobs.some((job) => job.status === 'running')) {
    throw new Error('Уже идёт сбор погоды. Дождитесь его завершения.');
  }
  const job = {
    schemaVersion: 1,
    id: randomUUID(),
    ...request,
    status: 'running',
    startedAt: now.toISOString(),
    endsAt: new Date(
      now.getTime() + request.durationMinutes * 60_000,
    ).toISOString(),
    nextDueAt: now.toISOString(),
    samples: [],
    errors: [],
    aggregate: null,
  };
  return saveWeatherJob(job, dataDir);
}

export function aggregateWeatherJob(job) {
  const { sampleCount, ...aggregate } = aggregateReadings(job.samples);
  return {
    sampleCount,
    expectedSampleCount: Math.ceil(job.durationMinutes / job.intervalMinutes),
    ...aggregate,
  };
}

// Result of get_weather_summary for a job; running jobs get a partial aggregate.
export function describeWeatherJob(job) {
  return {
    kind: 'job',
    jobId: job.id,
    status: job.status,
    city: job.city,
    intervalMinutes: job.intervalMinutes,
    durationMinutes: job.durationMinutes,
    startedAt: job.startedAt,
    endsAt: job.endsAt,
    completedAt: job.completedAt ?? null,
    aggregate: job.aggregate ?? aggregateWeatherJob(job),
    readings: job.samples.map((sample) => ({
      collectedAt: sample.collectedAt,
      temperatureC: sample.temperatureC,
      precipitationMm: sample.precipitationMm ?? null,
      rainMm: sample.rainMm ?? null,
      showersMm: sample.showersMm ?? null,
      weatherCode: sample.weatherCode ?? null,
    })),
    failedAttempts: job.errors.length,
  };
}

// Does whatever is due for running jobs; safe to call every minute from cron.
export async function runWeatherJobsTick({
  now = new Date(),
  dataDir = dataDirectory(),
  fetchWeather,
}) {
  const changed = [];
  for (const job of await listWeatherJobs(dataDir)) {
    if (job.status !== 'running') continue;
    const nowMs = now.getTime();
    if (nowMs >= Date.parse(job.endsAt)) {
      job.status = 'completed';
      job.aggregate = aggregateWeatherJob(job);
      job.completedAt = now.toISOString();
    } else if (nowMs >= Date.parse(job.nextDueAt)) {
      const intervalMs = job.intervalMinutes * 60_000;
      const slot = Math.floor((nowMs - Date.parse(job.startedAt)) / intervalMs);
      try {
        job.samples.push(readingFromWeather(await fetchWeather(job.city), now));
      } catch (error) {
        job.errors.push({
          at: now.toISOString(),
          message: errorMessage(error, 'Ошибка MCP'),
        });
      }
      job.nextDueAt = new Date(
        Date.parse(job.startedAt) + (slot + 1) * intervalMs,
      ).toISOString();
    } else {
      continue;
    }
    await saveWeatherJob(job, dataDir);
    changed.push(job);
  }
  return changed;
}
