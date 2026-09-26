// Local MCP server «Поездки»: rough travel estimates between two cities.
import { pathToFileURL } from 'node:url';

import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from '@modelcontextprotocol/server';

import { errorResult, listenMcp, portFromEnv, textResult } from './listen.mjs';

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const EARTH_RADIUS_KM = 6371;
const DAY_MS = 86_400_000;

async function geocode(name, fetchImpl) {
  const url = new URL(GEOCODING_URL);
  url.search = new URLSearchParams({
    name,
    count: '1',
    language: 'ru',
  }).toString();
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Геокодер вернул HTTP ${response.status}`);
  }
  const place = (await response.json())?.results?.[0];
  if (
    !place ||
    typeof place.name !== 'string' ||
    !Number.isFinite(place.latitude) ||
    !Number.isFinite(place.longitude)
  ) {
    throw new Error(`Город «${name}» не найден`);
  }
  return {
    name: place.name,
    country: place.country ?? null,
    latitude: place.latitude,
    longitude: place.longitude,
  };
}

function distanceKm(from, to) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = radians(to.latitude - from.latitude);
  const dLon = radians(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(from.latitude)) *
      Math.cos(radians(to.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

function roundHours(hours) {
  return Math.max(0.5, Math.round(hours * 2) / 2);
}

// Distance-based estimate: roads are ~25% longer than the straight line.
export function estimateTrip(from, to) {
  const straight = distanceKm(from, to);
  const road = straight * 1.25;
  const options = [
    { mode: 'train', label: 'Поезд', hours: roundHours(road / 100 + 0.5) },
    { mode: 'car', label: 'Автомобиль', hours: roundHours(road / 85) },
  ];
  if (straight >= 500) {
    options.push({
      mode: 'plane',
      label: 'Самолёт с дорогой до аэропорта',
      hours: roundHours(straight / 700 + 3),
    });
  }
  const recommended = options.reduce((best, option) =>
    option.hours < best.hours ? option : best,
  ).mode;
  return {
    distanceKm: Math.round(straight),
    roadDistanceKm: Math.round(road),
    options,
    recommended,
  };
}

/**
 * @param {{ from: string, to: string, date?: string }} trip
 * @param {{ fetchImpl?: typeof fetch, now?: Date }} [options]
 */
export async function planTrip(
  { from, to, date },
  { fetchImpl = fetch, now = new Date() } = {},
) {
  const [origin, destination] = await Promise.all([
    geocode(from.trim(), fetchImpl),
    geocode(to.trim(), fetchImpl),
  ]);
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return {
    from: origin,
    to: destination,
    ...(date
      ? { date, daysUntil: Math.round((Date.parse(date) - today) / DAY_MS) }
      : {}),
    ...estimateTrip(origin, destination),
    note: 'Оценка по расстоянию, без расписаний и пробок',
  };
}

export function createTravelMcpHandler({ fetchImpl = fetch } = {}) {
  return createMcpHandler(() => {
    const mcp = new McpServer({
      name: 'ai-challenge-travel',
      version: '1.0.0',
    });
    mcp.registerTool(
      'plan_trip',
      {
        description:
          'Оценить дорогу между двумя городами: расстояние, время на поезде, ' +
          'машине и самолёте и рекомендуемый вариант. С date (ГГГГ-ММ-ДД) — ещё и сколько дней до поездки.',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            from: {
              type: 'string',
              minLength: 2,
              maxLength: 120,
              description: 'Город отправления',
            },
            to: {
              type: 'string',
              minLength: 2,
              maxLength: 120,
              description: 'Город назначения',
            },
            date: {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
              description: 'Дата поездки, ГГГГ-ММ-ДД',
            },
          },
          required: ['from', 'to'],
          additionalProperties: false,
        }),
      },
      async (args) => {
        try {
          return textResult(await planTrip(args, { fetchImpl }));
        } catch (error) {
          return errorResult(error, 'Не удалось оценить поездку');
        }
      },
    );
    return mcp;
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await listenMcp(createTravelMcpHandler(), {
    name: 'Travel',
    port: portFromEnv('MCP_TRAVEL_PORT', 18801),
  });
}
