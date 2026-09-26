import { describe, expect, test, vi } from 'vitest';

import { getCurrentWeather } from '../scripts/mcp/weather.mjs';

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('getCurrentWeather', () => {
  test('находит город и запрашивает текущую погоду', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          results: [
            {
              name: 'Москва',
              country: 'Россия',
              latitude: 55.75,
              longitude: 37.62,
              timezone: 'Europe/Moscow',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          timezone: 'Europe/Moscow',
          current: { time: '2026-09-22T12:00', temperature_2m: 18.5 },
          current_units: { temperature_2m: '°C' },
        }),
      );

    const weather = await getCurrentWeather('  Москва  ', fetchMock);
    expect(weather).toEqual({
      source: 'Open-Meteo',
      location: {
        name: 'Москва',
        country: 'Россия',
        timezone: 'Europe/Moscow',
      },
      current: { time: '2026-09-22T12:00', temperature_2m: 18.5 },
      units: { temperature_2m: '°C' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const geocodingUrl = fetchMock.mock.calls[0]?.[0];
    expect(geocodingUrl).toBeInstanceOf(URL);
    if (!(geocodingUrl instanceof URL))
      throw new Error('Geocoding URL is missing');
    expect(geocodingUrl.searchParams.get('name')).toBe('Москва');
    const forecastUrl = fetchMock.mock.calls[1]?.[0];
    expect(forecastUrl).toBeInstanceOf(URL);
    if (!(forecastUrl instanceof URL))
      throw new Error('Forecast URL is missing');
    expect(forecastUrl.searchParams.get('latitude')).toBe('55.75');
    expect(forecastUrl.searchParams.get('current')).toContain('temperature_2m');
    // The scheduler tells rain from snow by these fields.
    expect(forecastUrl.searchParams.get('current')?.split(',')).toEqual(
      expect.arrayContaining([
        'precipitation',
        'rain',
        'showers',
        'weather_code',
      ]),
    );
  });

  test('не вызывает API при пустом названии', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(getCurrentWeather(' ', fetchMock)).rejects.toThrow(
      'Укажите город',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('сообщает, если город не найден', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({}));
    await expect(
      getCurrentWeather('Несуществующий город', fetchMock),
    ).rejects.toThrow('не найден');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('сообщает об ошибке, если оба адреса прогноза ответили ошибкой', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          results: [{ name: 'Москва', latitude: 55.75, longitude: 37.62 }],
        }),
      )
      .mockResolvedValue(response({ error: true }, 503));
    await expect(getCurrentWeather('Москва', fetchMock)).rejects.toThrow(
      'HTTP 503',
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // Changes the remembered endpoint, so it stays the last test in the file.
  test('при недоступном основном адресе берёт прогноз с запасного и запоминает его', async () => {
    const hosts: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      hosts.push(url.host);
      if (url.host === 'geocoding-api.open-meteo.com') {
        return response({
          results: [{ name: 'Москва', latitude: 55.75, longitude: 37.62 }],
        });
      }
      if (url.host === 'api.open-meteo.com')
        throw new TypeError('fetch failed');
      return response({
        current: { time: '2026-09-26T16:15', temperature_2m: 16 },
        current_units: { temperature_2m: '°C' },
      });
    });

    await expect(getCurrentWeather('Москва', fetchMock)).resolves.toMatchObject(
      { current: { temperature_2m: 16 } },
    );
    await getCurrentWeather('Москва', fetchMock);

    expect(hosts).toEqual([
      'geocoding-api.open-meteo.com',
      'api.open-meteo.com',
      'historical-forecast-api.open-meteo.com',
      'geocoding-api.open-meteo.com',
      'historical-forecast-api.open-meteo.com',
    ]);
  });
});
