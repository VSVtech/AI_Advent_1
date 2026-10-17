import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';
import { SUPPORT_DEFAULT_QUESTION, parseSupportCommand } from '@/lib/support-command';
import { supportCommand } from '@/lib/support-tickets';
import {
  DEFAULT_SUPPORT_DIR,
  getAuthEvents,
  getTicket,
  getUser,
  listTickets,
  listUserTickets,
} from '@/scripts/mcp-servers/support.mjs';

const dir = DEFAULT_SUPPORT_DIR;

describe('support MCP data', () => {
  it('returns a ticket, its user and the auth events that explain it', async () => {
    const ticket = await getTicket('TCK-1002', dir);
    expect(ticket.userId).toBe('u-1002');
    expect((await getUser(ticket.userId, dir)).status).toBe('locked');
    const events = await getAuthEvents(ticket.userId, dir, 3);
    expect(events.map((e: { event: string }) => e.event)).toEqual([
      'login_failed',
      'account_locked',
      'login_rejected',
    ]);
  });

  it('every auth ticket has a cause in the log and a FAQ code', async () => {
    const codes: Record<string, string> = {
      'TCK-1001': 'sms_limit_exceeded',
      'TCK-1002': 'account_locked',
      'TCK-1003': 'client_too_old',
      'TCK-1004': 'sso_assertion_expired',
      'TCK-1006': 'email_bounced',
    };
    for (const [id, code] of Object.entries(codes)) {
      const { userId } = await getTicket(id, dir);
      const log = JSON.stringify(await getAuthEvents(userId, dir, 20));
      expect(log).toContain(code);
    }
  });

  it('lists the queue with author names and tickets of one user', async () => {
    const queue = await listTickets(dir);
    expect(queue.find((t: { id: string }) => t.id === 'TCK-1001')).toMatchObject({
      userName: 'Анна Петрова',
    });
    expect(
      (await listUserTickets('u-1001', dir)).map((t: { id: string }) => t.id),
    ).toEqual(['TCK-1001', 'TCK-1005']);
  });

  it('rejects malformed ids and missing records', async () => {
    await expect(getTicket('../etc/passwd', dir)).rejects.toThrow('номер тикета');
    await expect(getUser('u-1; drop', dir)).rejects.toThrow('id пользователя');
    await expect(getTicket('TCK-9999', dir)).rejects.toThrow('не найден');
    await expect(getAuthEvents('u-1001', dir, 99)).rejects.toThrow('limit');
  });
});

describe('/support command', () => {
  it('extracts the ticket and the question', () => {
    expect(parseSupportCommand('/support tck-1001 Почему не работает вход?')).toBe(
      'Тикет TCK-1001. Вопрос сотрудника поддержки: Почему не работает вход?',
    );
    expect(parseSupportCommand('/support Как вернуть деньги?')).toContain(
      'тикет не указан',
    );
    expect(parseSupportCommand('/support')).toContain(SUPPORT_DEFAULT_QUESTION);
    expect(parseSupportCommand('/supports TCK-1001')).toBeNull();
    expect(parseSupportCommand('привет /support')).toBeNull();
  });

  it('is built by the desk in the same format', () => {
    expect(supportCommand('TCK-1001', 'Что делать?')).toBe(
      '/support TCK-1001 Что делать?',
    );
    expect(supportCommand(null, 'Что делать?')).toBe('/support Что делать?');
  });
});

describe('/support in the chat API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('turns on RAG, drops grounding and adds the support prompt', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-secret');
    for (const name of ['CAPSULE', 'TRAVEL', 'NOTES', 'GIT', 'SUPPORT']) {
      vi.stubEnv(`MCP_${name}_URL`, 'not a url');
    }
    const sse =
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":1,"input_tokens":1}}}\n\n';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          build_id: 'b1',
          hits: [
            {
              id: 'S1',
              chunk_id: 'c1',
              source: 'docs/support/faq.md',
              title: 'FAQ',
              section: 'FAQ / SMS',
              start_line: 1,
              end_line: 3,
              score: 0.8,
              text: 'Не более 3 SMS в час.',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'user', content: '/support TCK-1001 Почему не работает авторизация?' },
          ],
          useRag: false,
          ragGrounding: true,
          ragDialogue: true,
          useMcpTools: false,
          useSystemPrompt: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    const search = JSON.stringify(JSON.parse(fetchMock.mock.calls[0][1].body));
    expect(search).toContain('Тикет TCK-1001');
    expect(search).not.toContain('/support');
    const answer = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(answer.instructions).toContain('Команда /support');
    expect(answer.instructions).toContain('get_auth_events');
  });
});
