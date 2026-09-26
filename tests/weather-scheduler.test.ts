import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import {
  createWeatherJob,
  readWeatherJob,
  runWeatherJobsTick,
  validateJobRequest,
} from '@/scripts/mcp/weather-jobs.mjs';
import {
  aggregateReadings,
  moscowClock,
  rainInReading,
  readLatestReport,
  readSamples,
  readSchedulerStatus,
  saveSample,
} from '@/scripts/mcp/weather-store.mjs';
import { runWeatherTick } from '@/scripts/mcp/weather-tick.mjs';

const temporaryDirs: string[] = [];

async function newDataDir() {
  const directory = await mkdtemp(join(tmpdir(), 'weather-scheduler-'));
  temporaryDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

function weather(
  temperatureC: number,
  { code = 0, rain = 0, showers = 0 } = {},
) {
  return {
    current: {
      time: '2026-09-26T16:00',
      temperature_2m: temperatureC,
      precipitation: rain + showers,
      rain,
      showers,
      weather_code: code,
    },
  };
}

test('cron каждую минуту: почасовой замер делается один раз в час', async () => {
  const dataDir = await newDataDir();
  const fetchWeather = vi.fn().mockResolvedValue(weather(13.5));
  const now = new Date('2026-09-26T10:00:05.000Z');

  await runWeatherTick({ now, dataDir, fetchWeather });
  await runWeatherTick({
    now: new Date('2026-09-26T10:01:05.000Z'),
    dataDir,
    fetchWeather,
  });

  expect(moscowClock(now)).toEqual({ date: '2026-09-26', hour: 13 });
  expect(fetchWeather).toHaveBeenCalledOnce();
  expect(fetchWeather).toHaveBeenCalledWith('Москва');
  expect(await readSamples('2026-09-26', dataDir)).toMatchObject([
    { hour: 13, temperatureC: 13.5, rainMm: 0, showersMm: 0 },
  ]);
  expect(await readSchedulerStatus(dataDir)).toMatchObject({
    state: 'ok',
    lastTickAt: '2026-09-26T10:01:05.000Z',
    lastSampleAt: '2026-09-26T10:00:05.000Z',
  });
});

test('в 16:00 МСК сводка строится из сохранённых замеров, дождь виден по rain', async () => {
  const dataDir = await newDataDir();
  await saveSample(weather(9), new Date('2026-09-26T06:00:00.000Z'), dataDir);
  // Overcast code, but Open-Meteo reports rain: the reading counts as rain.
  await saveSample(
    weather(15, { code: 3, rain: 0.4 }),
    new Date('2026-09-26T11:00:00.000Z'),
    dataDir,
  );
  const fetchWeather = vi.fn().mockResolvedValue(weather(12));

  const result = await runWeatherTick({
    now: new Date('2026-09-26T13:00:01.000Z'),
    dataDir,
    fetchWeather,
  });

  expect(result.report).toMatchObject({
    date: '2026-09-26',
    minTemperatureC: 9,
    maxTemperatureC: 15,
    rainObserved: true,
    sampleCount: 3,
    hours: [9, 14, 16],
  });
  expect(await readLatestReport(dataDir)).toEqual(result.report);
  const later = await runWeatherTick({
    now: new Date('2026-09-26T13:15:00.000Z'),
    dataDir,
    fetchWeather,
  });
  expect(later.report).toBeNull();
  expect(fetchWeather).toHaveBeenCalledOnce();
});

test('сбой замера в 16:00: сводка неполная, повтор через 5 минут её дополняет', async () => {
  const dataDir = await newDataDir();
  await saveSample(weather(10), new Date('2026-09-26T12:00:00.000Z'), dataDir);
  const failing = vi.fn().mockRejectedValue(new Error('MCP unavailable'));

  const failed = await runWeatherTick({
    now: new Date('2026-09-26T13:00:00.000Z'),
    dataDir,
    fetchWeather: failing,
  });
  expect(failed.error).toBeInstanceOf(Error);
  expect(await readLatestReport(dataDir)).toMatchObject({
    sampleCount: 1,
    hours: [15],
  });
  expect(await readSchedulerStatus(dataDir)).toMatchObject({
    state: 'error',
    message: 'MCP unavailable',
    nextHourlyAttemptAt: '2026-09-26T13:05:00.000Z',
  });

  await runWeatherTick({
    now: new Date('2026-09-26T13:02:00.000Z'),
    dataDir,
    fetchWeather: failing,
  });
  expect(failing).toHaveBeenCalledOnce();
  expect(await readSchedulerStatus(dataDir)).toMatchObject({ state: 'error' });

  await runWeatherTick({
    now: new Date('2026-09-26T13:05:00.000Z'),
    dataDir,
    fetchWeather: async () => weather(12, { code: 61, rain: 1.2 }),
  });
  expect(await readLatestReport(dataDir)).toMatchObject({
    sampleCount: 2,
    hours: [15, 16],
    rainObserved: true,
  });
  const status = await readSchedulerStatus(dataDir);
  expect(status).toMatchObject({ state: 'ok' });
  expect(status).not.toHaveProperty('nextHourlyAttemptAt');
});

test('признак дождя: rain и showers, коды погоды; снег не считается дождём', () => {
  expect(rainInReading({ rainMm: 0.2, showersMm: 0, weatherCode: 3 })).toBe(
    true,
  );
  expect(
    rainInReading({
      rainMm: 0,
      showersMm: 0,
      precipitationMm: 0.6,
      weatherCode: 71,
    }),
  ).toBe(false);
  // Readings without rain/showers fall back to precipitation and codes.
  expect(rainInReading({ precipitationMm: 0.6, weatherCode: 3 })).toBe(true);
  expect(
    rainInReading({ rainMm: null, showersMm: null, weatherCode: 71 }),
  ).toBe(false);
  expect(
    rainInReading({ rainMm: null, showersMm: null, weatherCode: 61 }),
  ).toBe(true);
  expect(
    rainInReading({
      rainMm: null,
      showersMm: null,
      precipitationMm: null,
      weatherCode: null,
    }),
  ).toBeNull();
  expect(aggregateReadings([])).toEqual({
    minTemperatureC: null,
    maxTemperatureC: null,
    rainObserved: null,
    sampleCount: 0,
  });
});

test('задание: замеры по слотам интервала, по окончании — агрегат', async () => {
  const dataDir = await newDataDir();
  const startedAt = new Date('2026-09-26T10:00:30.000Z');
  const job = await createWeatherJob(
    { intervalMinutes: 2, durationMinutes: 20 },
    { now: startedAt, dataDir },
  );
  const fetchWeather = vi
    .fn()
    .mockResolvedValueOnce(weather(12))
    .mockResolvedValueOnce(weather(14, { code: 61, rain: 1.2 }));
  const at = (seconds: number) =>
    new Date(startedAt.getTime() + seconds * 1_000);

  // cron starts on the minute boundary, so the first reading may be late.
  await runWeatherJobsTick({ now: at(30), dataDir, fetchWeather });
  await runWeatherJobsTick({ now: at(90), dataDir, fetchWeather });
  expect(fetchWeather).toHaveBeenCalledOnce();
  await runWeatherJobsTick({ now: at(150), dataDir, fetchWeather });
  expect(fetchWeather).toHaveBeenCalledTimes(2);
  expect(fetchWeather).toHaveBeenCalledWith('Москва');
  expect(await readWeatherJob(job.id, dataDir)).toMatchObject({
    status: 'running',
    samples: [{ temperatureC: 12 }, { temperatureC: 14, rainMm: 1.2 }],
    nextDueAt: '2026-09-26T10:04:30.000Z',
  });

  await runWeatherJobsTick({ now: at(20 * 60), dataDir, fetchWeather });
  expect(await readWeatherJob(job.id, dataDir)).toMatchObject({
    status: 'completed',
    aggregate: {
      sampleCount: 2,
      expectedSampleCount: 10,
      minTemperatureC: 12,
      maxTemperatureC: 14,
      rainObserved: true,
    },
  });
  await runWeatherJobsTick({ now: at(21 * 60), dataDir, fetchWeather });
  expect(fetchWeather).toHaveBeenCalledTimes(2);
});

test('сбой MCP в задании сохраняется отдельно, повтор не дублирует замеры', async () => {
  const dataDir = await newDataDir();
  const startedAt = new Date('2026-09-26T10:00:00.000Z');
  const job = await createWeatherJob(
    { city: 'Казань', intervalMinutes: 2, durationMinutes: 20 },
    { now: startedAt, dataDir },
  );
  const fetchWeather = vi
    .fn()
    .mockRejectedValueOnce(new Error('MCP timeout'))
    .mockResolvedValueOnce(weather(9));

  await runWeatherJobsTick({ now: startedAt, dataDir, fetchWeather });
  expect(await readWeatherJob(job.id, dataDir)).toMatchObject({
    city: 'Казань',
    errors: [{ message: 'MCP timeout' }],
    samples: [],
  });
  await runWeatherJobsTick({
    now: new Date('2026-09-26T10:01:00.000Z'),
    dataDir,
    fetchWeather,
  });
  await runWeatherJobsTick({
    now: new Date('2026-09-26T10:02:00.000Z'),
    dataDir,
    fetchWeather,
  });
  expect(fetchWeather).toHaveBeenCalledTimes(2);
  expect(await readWeatherJob(job.id, dataDir)).toMatchObject({
    samples: [{ temperatureC: 9 }],
  });
});

test('параметры задания: город по умолчанию, лимиты и одно задание за раз', async () => {
  const dataDir = await newDataDir();
  expect(
    validateJobRequest({ intervalMinutes: 2, durationMinutes: 20 }),
  ).toEqual({ city: 'Москва', intervalMinutes: 2, durationMinutes: 20 });
  expect(
    validateJobRequest({ intervalMinutes: 0, durationMinutes: 20 }),
  ).toBeNull();
  expect(
    validateJobRequest({ intervalMinutes: 2, durationMinutes: 240 }),
  ).toBeNull();
  expect(
    validateJobRequest({ intervalMinutes: 1, durationMinutes: 120 }),
  ).toBeNull();
  expect(
    validateJobRequest({ city: 'X', intervalMinutes: 2, durationMinutes: 20 }),
  ).toBeNull();

  await createWeatherJob(
    { intervalMinutes: 2, durationMinutes: 20 },
    { dataDir },
  );
  await expect(
    createWeatherJob({ intervalMinutes: 5, durationMinutes: 30 }, { dataDir }),
  ).rejects.toThrow('Уже идёт сбор погоды');
});
