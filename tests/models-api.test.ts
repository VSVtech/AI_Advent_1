import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/api/models/route';
import { DEFAULT_MODEL } from '@/lib/chat-constraints';

const originalApiKey = process.env.DEEPSEEK_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalApiKey;
  vi.unstubAllGlobals();
});

describe('GET /api/models', () => {
  it('не запускается без серверного токена', async () => {
    delete process.env.DEEPSEEK_API_KEY;

    const response = await GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'configuration_error',
        message: 'DEEPSEEK_API_KEY не настроен. Добавьте токен в .env.local.',
      },
    });
  });

  it('возвращает отсортированный список моделей от DeepSeek', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        object: 'list',
        data: [
          { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
          { id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek' },
          { id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek' },
          { id: '  ', object: 'model', owned_by: 'deepseek' },
          { object: 'model', owned_by: 'deepseek' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      default: DEFAULT_MODEL,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/models');
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer test-secret',
    );
  });

  it.each([
    'upstream_error_status',
    'upstream_unreachable',
    'malformed_json',
    'empty_data',
  ])('деградирует до модели по умолчанию при %s', async (scenario) => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';

    if (scenario === 'upstream_error_status') {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
      );
    } else if (scenario === 'upstream_unreachable') {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('network down')),
      );
    } else if (scenario === 'malformed_json') {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('not json', { status: 200 })),
      );
    } else {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(Response.json({ object: 'list', data: [] })),
      );
    }

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      models: [DEFAULT_MODEL],
      default: DEFAULT_MODEL,
    });
  });

  it('не раскрывает токен в ответе', async () => {
    process.env.DEEPSEEK_API_KEY = 'super-secret-token';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
    );

    const response = await GET();

    expect(await response.text()).not.toContain('super-secret-token');
  });
});
