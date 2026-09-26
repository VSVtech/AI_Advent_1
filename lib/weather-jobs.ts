export const WEATHER_API_URL = '/api/weather';
export const MAX_TRACKED_WEATHER_JOBS = 5;

export type WeatherJobResult =
  | { id: string; status: 'running' }
  | { id: string; status: 'completed' | 'not_found'; content: string };

function isWeatherJobResult(value: unknown): value is WeatherJobResult {
  if (!value || typeof value !== 'object') return false;
  const { id, status, content } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    (status === 'running' ||
      ((status === 'completed' || status === 'not_found') &&
        typeof content === 'string' &&
        content.trim().length > 0))
  );
}

// Asks the app server, which reads jobs through the MCP get_weather_summary tool.
export async function fetchWeatherJobResults(
  jobIds: string[],
  model: string,
): Promise<WeatherJobResult[]> {
  const response = await fetch(WEATHER_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobIds, model }),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error('Не удалось получить результат сбора погоды.');
  }
  const payload = (await response.json()) as { jobs?: unknown };
  return Array.isArray(payload.jobs)
    ? payload.jobs.filter(isWeatherJobResult)
    : [];
}
