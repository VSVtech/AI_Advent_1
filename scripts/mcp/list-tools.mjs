import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

const endpoint = new URL(
  process.env.MCP_SERVER_URL ?? 'http://127.0.0.1:8765/mcp',
);
const client = new Client({
  name: 'ai-challenge-mcp-client',
  version: '1.0.0',
});

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const { tools } = await client.listTools();
  console.log(
    JSON.stringify(
      tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    'Не удалось получить инструменты MCP:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
