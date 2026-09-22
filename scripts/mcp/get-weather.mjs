import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

const city = process.argv.slice(2).join(' ').trim();
if (!city) {
  console.error('Использование: npm run mcp:weather -- <город>');
  process.exit(1);
}

const endpoint = new URL(
  process.env.MCP_SERVER_URL ?? 'http://127.0.0.1:8765/mcp',
);
const client = new Client({
  name: 'ai-challenge-weather-client',
  version: '1.0.0',
});

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const result = await client.callTool({
    name: 'get_weather',
    arguments: { city },
  });
  if (result.isError) {
    throw new Error(result.content.map((item) => item.text ?? '').join('\n'));
  }
  for (const item of result.content) {
    if (item.type === 'text') console.log(item.text);
  }
} catch (error) {
  console.error(
    'Не удалось получить погоду через MCP:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
