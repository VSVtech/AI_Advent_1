// Local MCP server «Поддержка»: read-only access to support tickets, users and
// their authorization events (JSON files stand in for a CRM).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from '@modelcontextprotocol/server';

import { errorResult, listenMcp, portFromEnv, textResult } from './listen.mjs';

export const DEFAULT_SUPPORT_DIR = fileURLToPath(
  new URL('../../data/support', import.meta.url),
);
export const TICKET_ID = /^TCK-\d{4,6}$/u;
export const USER_ID = /^u-\d{3,6}$/u;
const MAX_EVENTS = 20;

async function load(dir, name) {
  return JSON.parse(await readFile(join(dir, name), 'utf8'));
}

function checkId(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Некорректный ${label}`);
  }
  return value;
}

export async function getTicket(ticketId, dir) {
  checkId(ticketId, TICKET_ID, 'номер тикета');
  const ticket = (await load(dir, 'tickets.json')).find(
    (item) => item.id === ticketId,
  );
  if (!ticket) throw new Error(`Тикет ${ticketId} не найден`);
  return ticket;
}

export async function getUser(userId, dir) {
  checkId(userId, USER_ID, 'id пользователя');
  const user = (await load(dir, 'users.json')).find(
    (item) => item.id === userId,
  );
  if (!user) throw new Error(`Пользователь ${userId} не найден`);
  return user;
}

export async function listTickets(dir) {
  const [tickets, users] = await Promise.all([
    load(dir, 'tickets.json'),
    load(dir, 'users.json'),
  ]);
  return tickets.map(({ id, subject, status, createdAt, userId }) => ({
    id,
    subject,
    status,
    createdAt,
    userId,
    userName: users.find((user) => user.id === userId)?.name ?? 'Неизвестно',
  }));
}

export async function listUserTickets(userId, dir) {
  checkId(userId, USER_ID, 'id пользователя');
  const tickets = (await load(dir, 'tickets.json')).filter(
    (item) => item.userId === userId,
  );
  return tickets.map(({ id, subject, status, createdAt }) => ({
    id,
    subject,
    status,
    createdAt,
  }));
}

export async function getAuthEvents(userId, dir, limit = 10) {
  checkId(userId, USER_ID, 'id пользователя');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENTS) {
    throw new Error(`limit: целое от 1 до ${MAX_EVENTS}`);
  }
  const events = (await load(dir, 'auth-events.json'))
    .filter((item) => item.userId === userId)
    .sort((left, right) => left.at.localeCompare(right.at));
  // The newest events matter most, but they are shown in chronological order.
  return events.slice(-limit).map(({ at, event, detail }) => ({ at, event, detail }));
}

export function createSupportMcpHandler({
  dir = process.env.SUPPORT_DATA_DIR ?? DEFAULT_SUPPORT_DIR,
} = {}) {
  const tool = (mcp, name, description, properties, required, run) =>
    mcp.registerTool(
      name,
      {
        description,
        inputSchema: fromJsonSchema({
          type: 'object',
          properties,
          required,
          additionalProperties: false,
        }),
      },
      async (args) => {
        try {
          return textResult(await run(args ?? {}));
        } catch (error) {
          return errorResult(error, 'Не удалось получить данные поддержки');
        }
      },
    );
  const userIdProperty = {
    type: 'string',
    pattern: USER_ID.source,
    description: 'id пользователя, например u-1001',
  };
  return createMcpHandler(() => {
    const mcp = new McpServer({ name: 'ai-challenge-support', version: '1.0.0' });
    tool(
      mcp,
      'get_ticket',
      'Тикет поддержки по номеру: тема, статус, сообщения пользователя и userId автора',
      {
        ticketId: {
          type: 'string',
          pattern: TICKET_ID.source,
          description: 'Номер тикета, например TCK-1001',
        },
      },
      ['ticketId'],
      ({ ticketId }) => getTicket(ticketId, dir),
    );
    tool(
      mcp,
      'get_user',
      'Карточка пользователя: тариф, статус аккаунта, платформа и версия приложения, способы входа',
      { userId: userIdProperty },
      ['userId'],
      ({ userId }) => getUser(userId, dir),
    );
    tool(
      mcp,
      'list_tickets',
      'Очередь поддержки: все тикеты с темой, статусом и именем автора (для экрана сотрудника, не для ответа пользователю)',
      {},
      [],
      async () => ({ tickets: await listTickets(dir) }),
    );
    tool(
      mcp,
      'list_user_tickets',
      'Все тикеты пользователя (номер, тема, статус)',
      { userId: userIdProperty },
      ['userId'],
      async ({ userId }) => ({ tickets: await listUserTickets(userId, dir) }),
    );
    tool(
      mcp,
      'get_auth_events',
      'Последние события авторизации пользователя (вход, блокировки, SMS, SSO, сброс пароля) от старых к новым',
      {
        userId: userIdProperty,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_EVENTS,
          description: 'Сколько последних событий вернуть, по умолчанию 10',
        },
      },
      ['userId'],
      async ({ userId, limit }) => ({
        events: await getAuthEvents(userId, dir, limit),
      }),
    );
    return mcp;
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await listenMcp(createSupportMcpHandler(), {
    name: 'Support',
    port: portFromEnv('MCP_SUPPORT_PORT', 18806),
  });
}
