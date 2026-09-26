import { vi } from 'vitest';

export const CITIES: Record<string, { latitude: number; longitude: number }> = {
  Берлин: { latitude: 52.52437, longitude: 13.41053 },
  Потсдам: { latitude: 52.39886, longitude: 13.06566 },
  Москва: { latitude: 55.75222, longitude: 37.61556 },
};

// Stands in for the Open-Meteo geocoder used by the «Поездки» server.
export function createGeocodingStub() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const name = url.searchParams.get('name') ?? '';
    const place = CITIES[name];
    return Response.json(
      place
        ? { results: [{ name, country: 'Германия', ...place }] }
        : { results: [] },
    );
  });
}
