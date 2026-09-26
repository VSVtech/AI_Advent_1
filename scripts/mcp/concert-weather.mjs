// Runs the «concert weather» chain through MCP without a model:
// find_concert gives the city, get_weather receives exactly that city.
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

const performer = process.argv.slice(2).join(' ').trim();
if (!performer) {
  console.error('Использование: npm run mcp:concert-weather -- <исполнитель>');
  process.exit(1);
}

const endpoint = new URL(
  process.env.MCP_SERVER_URL ?? 'http://127.0.0.1:8765/mcp',
);
const client = new Client({
  name: 'ai-challenge-concert-weather',
  version: '1.0.0',
});

async function callJson(name, args) {
  const result = await client.callTool(
    { name, arguments: args },
    { timeout: 30_000 },
  );
  const text = result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('');
  if (result.isError) throw new Error(`${name}: ${text || 'ошибка'}`);
  return JSON.parse(text);
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const listing = await callJson('find_concert', { performer });
  if (!listing.found) {
    throw new Error(
      `концерт не найден; исполнители: ${listing.knownPerformers.join(', ')}`,
    );
  }
  for (const concert of listing.concerts) {
    const weather = await callJson('get_weather', { city: concert.city });
    console.log(
      JSON.stringify({
        performer: concert.performer,
        city: concert.city,
        date: concert.date,
        venue: concert.venue,
        weather: {
          location: weather.location,
          temperatureC: weather.current?.temperature_2m ?? null,
          weatherCode: weather.current?.weather_code ?? null,
          time: weather.current?.time ?? null,
        },
      }),
    );
  }
} catch (error) {
  console.error(
    'Не удалось выполнить цепочку find_concert → get_weather:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
