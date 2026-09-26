import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CITY = 'Москва';
export const TIME_ZONE = 'Europe/Moscow';
export const REPORT_HOUR = 16;
// Next to the deployed server.mjs, e.g. /home/user/mcp-demo/data on the capsule.
export const DEFAULT_DATA_DIR = fileURLToPath(
  new URL('./data', import.meta.url),
);

const RAIN_CODES = new Set([
  51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99,
]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function dataDirectory() {
  return process.env.WEATHER_DATA_DIR ?? DEFAULT_DATA_DIR;
}

export function isReportDate(value) {
  return typeof value === 'string' && DATE_PATTERN.test(value);
}

export function moscowClock(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  };
}

export async function writeJsonAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function errorMessage(error, fallback = 'Неизвестная ошибка') {
  return error instanceof Error ? error.message.slice(0, 300) : fallback;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

// Converts a get_weather MCP result into a stored reading.
export function readingFromWeather(weather, now = new Date()) {
  const current = weather?.current;
  if (!Number.isFinite(current?.temperature_2m)) {
    throw new Error('MCP не вернул корректную температуру');
  }
  return {
    collectedAt: now.toISOString(),
    providerTime: typeof current.time === 'string' ? current.time : null,
    temperatureC: current.temperature_2m,
    precipitationMm: finiteOrNull(current.precipitation),
    rainMm: finiteOrNull(current.rain),
    showersMm: finiteOrNull(current.showers),
    weatherCode: Number.isInteger(current.weather_code)
      ? current.weather_code
      : null,
  };
}

export function rainInReading(reading) {
  if (RAIN_CODES.has(reading.weatherCode)) return true;
  const liquid = [reading.rainMm, reading.showersMm].filter(Number.isFinite);
  if (liquid.some((value) => value > 0)) return true;
  if (liquid.length > 0) return false;
  // Readings without rain/showers only have total precipitation, which also
  // includes snow.
  if (SNOW_CODES.has(reading.weatherCode)) return false;
  if (Number.isFinite(reading.precipitationMm)) {
    return reading.precipitationMm > 0;
  }
  return Number.isInteger(reading.weatherCode) ? false : null;
}

export function aggregateReadings(readings) {
  const temperatures = readings.map((reading) => reading.temperatureC);
  const rain = readings.map(rainInReading);
  let rainObserved = null;
  if (rain.includes(true)) rainObserved = true;
  else if (rain.length > 0 && rain.every((value) => value === false)) {
    rainObserved = false;
  }
  return {
    minTemperatureC: temperatures.length ? Math.min(...temperatures) : null,
    maxTemperatureC: temperatures.length ? Math.max(...temperatures) : null,
    rainObserved,
    sampleCount: readings.length,
  };
}

function samplePath(dataDir, date, hour) {
  return join(
    dataDir,
    'samples',
    date,
    `${String(hour).padStart(2, '0')}.json`,
  );
}

function reportPath(dataDir, date) {
  return join(dataDir, 'reports', `${date}.json`);
}

export async function readSample(date, hour, dataDir = dataDirectory()) {
  return readJson(samplePath(dataDir, date, hour));
}

export async function saveSample(
  weather,
  now = new Date(),
  dataDir = dataDirectory(),
) {
  const { date, hour } = moscowClock(now);
  const sample = {
    schemaVersion: 1,
    city: CITY,
    timeZone: TIME_ZONE,
    date,
    hour,
    ...readingFromWeather(weather, now),
  };
  await writeJsonAtomically(samplePath(dataDir, date, hour), sample);
  return sample;
}

export async function readSamples(date, dataDir = dataDirectory()) {
  let files;
  try {
    files = await readdir(join(dataDir, 'samples', date));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const samples = await Promise.all(
    files
      .filter((name) => /^\d{2}\.json$/.test(name))
      .map((name) => readJson(join(dataDir, 'samples', date, name))),
  );
  return samples
    .filter(
      (sample) =>
        sample?.schemaVersion === 1 &&
        sample.date === date &&
        Number.isInteger(sample.hour) &&
        Number.isFinite(sample.temperatureC),
    )
    .sort((left, right) => left.hour - right.hour);
}

export function buildDailyReport(date, samples, now = new Date()) {
  return {
    schemaVersion: 1,
    city: CITY,
    timeZone: TIME_ZONE,
    date,
    generatedAt: now.toISOString(),
    ...aggregateReadings(samples),
    hours: samples.map((sample) => sample.hour),
  };
}

export async function saveReport(report, dataDir = dataDirectory()) {
  await writeJsonAtomically(reportPath(dataDir, report.date), report);
  return report;
}

export async function readReport(date, dataDir = dataDirectory()) {
  return isReportDate(date) ? readJson(reportPath(dataDir, date)) : null;
}

export async function readLatestReport(dataDir = dataDirectory()) {
  let files;
  try {
    files = await readdir(join(dataDir, 'reports'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const latest = files
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .at(-1);
  return latest ? readJson(join(dataDir, 'reports', latest)) : null;
}

export async function readSchedulerStatus(dataDir = dataDirectory()) {
  return readJson(join(dataDir, 'status.json'));
}

export async function saveSchedulerStatus(status, dataDir = dataDirectory()) {
  await writeJsonAtomically(join(dataDir, 'status.json'), status);
  return status;
}
