const CURRENT_VARIABLES = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'precipitation',
  'rain',
  'showers',
  'weather_code',
  'wind_speed_10m',
].join(',');
const FORECAST_ENDPOINTS = [
  'https://api.open-meteo.com/v1/forecast',
  // Same models and response format; reachable from networks (e.g. the
  // capsule) where the main host is blocked.
  'https://historical-forecast-api.open-meteo.com/v1/forecast',
];
// The last endpoint that answered is tried first, so a blocked host costs one
// timeout per server process rather than one per request.
let preferredForecastEndpoint = 0;

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Open-Meteo вернул HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchForecast(search, fetchImpl) {
  let lastError;
  for (let attempt = 0; attempt < FORECAST_ENDPOINTS.length; attempt += 1) {
    const index =
      (preferredForecastEndpoint + attempt) % FORECAST_ENDPOINTS.length;
    const url = new URL(FORECAST_ENDPOINTS[index]);
    url.search = search;
    try {
      const forecast = await fetchJson(url, fetchImpl);
      preferredForecastEndpoint = index;
      return forecast;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function getCurrentWeather(city, fetchImpl = fetch) {
  const query = typeof city === 'string' ? city.trim() : '';
  if (query.length < 2 || query.length > 120) {
    throw new Error('Укажите город длиной от 2 до 120 символов');
  }

  const geocodingUrl = new URL(
    'https://geocoding-api.open-meteo.com/v1/search',
  );
  geocodingUrl.search = new URLSearchParams({
    name: query,
    count: '1',
    language: 'ru',
  }).toString();
  const geocoding = await fetchJson(geocodingUrl, fetchImpl);
  const place = geocoding?.results?.[0];
  if (!place) {
    throw new Error(`Город «${query}» не найден`);
  }
  if (
    !Number.isFinite(place.latitude) ||
    !Number.isFinite(place.longitude) ||
    typeof place.name !== 'string'
  ) {
    throw new Error('Open-Meteo вернул некорректные координаты города');
  }

  const forecast = await fetchForecast(
    new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current: CURRENT_VARIABLES,
      timezone: 'auto',
    }).toString(),
    fetchImpl,
  );
  if (!forecast?.current || !forecast?.current_units) {
    throw new Error('Open-Meteo не вернул текущую погоду');
  }

  return {
    source: 'Open-Meteo',
    location: {
      name: place.name,
      country: place.country ?? null,
      timezone: forecast.timezone ?? place.timezone ?? null,
    },
    current: forecast.current,
    units: forecast.current_units,
  };
}
