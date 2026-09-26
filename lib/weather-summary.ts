export interface DailyWeatherSummary {
  schemaVersion: 1;
  city: string;
  timeZone: string;
  date: string;
  generatedAt: string;
  minTemperatureC: number | null;
  maxTemperatureC: number | null;
  rainObserved: boolean | null;
  sampleCount: number;
  hours: number[];
}

// State of the cron scheduler on the MCP server.
export interface WeatherSchedulerStatus {
  state: 'ok' | 'error';
  lastTickAt: string;
  lastSampleAt: string | null;
  message?: string;
}

export type WeatherSummaryResponse =
  | {
      status: 'ready';
      summary: DailyWeatherSummary;
      scheduler: WeatherSchedulerStatus | null;
    }
  | {
      status: 'pending';
      summary: null;
      scheduler: WeatherSchedulerStatus | null;
    };

export const WEATHER_SUMMARY_URL = '/api/weather';
