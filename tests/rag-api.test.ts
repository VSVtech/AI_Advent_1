import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/rag/route';

afterEach(() => vi.unstubAllGlobals());
describe('RAG proxy', () => {
  it('returns actionable status when the local service is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const response = await GET(new Request('http://localhost/api/rag'));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain(
      'pnpm rag:server',
    );
  });
  it('blocks cross-origin writes without calling the local service', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const response = await POST(
      new Request('http://localhost/api/rag', {
        method: 'POST',
        headers: { Origin: 'https://other.test' },
      }),
    );
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('forwards same-origin JSON without passing browser credentials or origin', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ job: { status: 'running' } }, { status: 202 }),
      );
    vi.stubGlobal('fetch', fetch);
    const response = await POST(
      new Request('http://localhost/api/rag', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost',
          'Content-Type': 'application/json',
          Cookie: 'private=1',
        },
        body: JSON.stringify({ action: 'index' }),
      }),
    );
    expect(response.status).toBe(202);
    expect(fetch.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
    });
  });
});
