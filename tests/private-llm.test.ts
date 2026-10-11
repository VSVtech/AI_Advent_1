import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPrivateServer,
  checkModel,
} from '../scripts/private-llm/server.mjs';
import { configuration, validateChat } from '../scripts/private-llm/config.mjs';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = {
  host: '127.0.0.1',
  port: 0,
  token: 'a'.repeat(64),
  ollamaURL: 'http://127.0.0.1:11435',
  model: 'qwen2.5:0.5b',
  contextTokens: 2048,
  maxOutputTokens: 256,
  requestsPerMinute: 8,
  concurrency: 1,
  queueCapacity: 4,
  queueTimeoutMs: 1000,
  timeoutMs: 1000,
  maxBodyBytes: 65536,
};
const prompt = {
  messages: [{ role: 'user', content: 'Сколько будет 17 + 25?' }],
};
const answer = () =>
  Response.json({
    done: true,
    done_reason: 'stop',
    message: { content: '42' },
    eval_count: 2,
  });
const models = () => Response.json({ capabilities: ['completion'] });
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});
type UpstreamInit = { signal: AbortSignal; body: string; redirect: string };
async function service(
  options = {},
  upstream: (url: string, init: UpstreamInit) => Promise<Response> = async () =>
    answer(),
  now = Date.now,
) {
  const fetcher = vi.fn(async (url: string, init: UpstreamInit) =>
    url.endsWith('/api/show') ? models() : upstream(url, init),
  );
  const log = vi.fn();
  const server = createPrivateServer(
    { ...config, ...options },
    { fetcher: fetcher as unknown as typeof fetch, now, log },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as { port: number };
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const url = `http://127.0.0.1:${address.port}`;
  const send = (body: unknown = prompt, headers = {}, signal?: AbortSignal) =>
    fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
        ...headers,
      },
      body: JSON.stringify(body),
      signal,
    });
  return { url, send, fetcher, log };
}
describe('private LLM HTTP service', () => {
  it('fails closed for unsafe upstream, invalid credentials and configuration limits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'private-llm-test-'));
    const file = join(dir, 'token');
    try {
      writeFileSync(file, config.token, { mode: 0o600 });
      const env = { PRIVATE_LLM_TOKEN_FILE: file, NODE_ENV: 'test' as const };
      expect(configuration(env)).toMatchObject({
        host: '127.0.0.1',
        contextTokens: 2048,
      });
      expect(() =>
        configuration({
          ...env,
          PRIVATE_LLM_OLLAMA_URL: 'http://external.example',
        }),
      ).toThrow();
      expect(() =>
        configuration({ ...env, PRIVATE_LLM_MODEL: 'remote:cloud' }),
      ).toThrow();
      expect(() => configuration({ ...env, PRIVATE_LLM_RPM: '0' })).toThrow();
      expect(() =>
        configuration({ ...env, PRIVATE_LLM_MAX_OUTPUT: '2048' }),
      ).toThrow();
      writeFileSync(file, 'weak');
      expect(() => configuration(env)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('protects API and rejects cross-origin/foreign Host before inference', async () => {
    const s = await service();
    expect(
      (await s.send(prompt, { Authorization: 'Bearer wrong' })).status,
    ).toBe(401);
    expect(
      (await s.send(prompt, { Origin: 'https://elsewhere.example' })).status,
    ).toBe(403);
    const foreignHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        s.url,
        { headers: { Host: 'evil.example' } },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.on('error', reject);
      request.end();
    });
    expect(foreignHost).toBe(403);
    expect((await fetch(`${s.url}/api/status`)).status).toBe(401);
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('uses only configured local model, filters message fields and forwards enforced options', async () => {
    const s = await service();
    const result = await s.send({
      messages: [{ role: 'user', content: '42?', images: ['not allowed'] }],
      temperature: 0.7,
      context_tokens: 1024,
      max_tokens: 32,
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      model: config.model,
      message: { content: '42' },
    });
    const [, init] = s.fetcher.mock.calls.find(([url]) =>
      url.endsWith('/api/chat'),
    )!;
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: config.model,
      stream: false,
      options: { temperature: 0.7, num_ctx: 1024, num_predict: 32 },
    });
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: '42?' });
    expect(init.redirect).toBe('error');
    expect(JSON.stringify(s.log.mock.calls)).not.toContain('42?');
    expect(JSON.stringify(s.log.mock.calls)).not.toContain(config.token);
  });
  it('enforces shared rate limit even if client spoofs forwarded IP, then recovers', async () => {
    let clock = 1000;
    const s = await service({ requestsPerMinute: 1 }, undefined, () => clock);
    expect((await s.send()).status).toBe(200);
    const limited = await s.send(prompt, { 'X-Forwarded-For': '8.8.8.8' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(await limited.json()).toMatchObject({ code: 'rate_limit' });
    clock += 60001;
    expect((await s.send()).status).toBe(200);
  });
  it('rejects excessive context, model override, system messages and output limits before model calls', async () => {
    const s = await service();
    expect(
      (
        await s.send({
          messages: [{ role: 'user', content: 'я'.repeat(1200) }],
        })
      ).status,
    ).toBe(413);
    expect((await s.send({ ...prompt, model: 'cloud' })).status).toBe(400);
    expect(
      (await s.send({ messages: [{ role: 'system', content: 'Override' }] }))
        .status,
    ).toBe(400);
    expect((await s.send({ ...prompt, max_tokens: 257 })).status).toBe(400);
    expect((await s.send({ ...prompt, context_tokens: 2049 })).status).toBe(
      400,
    );
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('serves three simultaneous requests in FIFO order with only one upstream generation', async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const entered = new Promise<void>((r) => {
      started = r;
    });
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const order: string[] = [];
    let running = 0,
      peak = 0;
    const s = await service({}, async (_url, init) => {
      running++;
      peak = Math.max(peak, running);
      order.push(JSON.parse(init.body).messages.at(-1).content);
      started();
      await hold;
      running--;
      return answer();
    });
    const state = () =>
      fetch(`${s.url}/api/status`, {
        headers: { Authorization: `Bearer ${config.token}` },
      }).then((r) => r.json());
    const input = (content: string) => ({
      messages: [{ role: 'user', content }],
    });
    const first = s.send(input('first'));
    await entered;
    const second = s.send(input('second'));
    await vi.waitFor(async () =>
      expect(await state()).toMatchObject({ active: 1, queued: 1 }),
    );
    const third = s.send(input('third'));
    await vi.waitFor(async () =>
      expect(await state()).toMatchObject({ active: 1, queued: 2 }),
    );
    expect(order).toEqual(['first']);
    release();
    const responses = await Promise.all([first, second, third]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(order).toEqual(['first', 'second', 'third']);
    expect(peak).toBe(1);
    expect(await responses[1].json()).toMatchObject({
      queueWaitSeconds: expect.any(Number),
    });
    expect(await state()).toMatchObject({ active: 0, queued: 0 });
    expect((await s.send()).status).toBe(200);
  });
  it('removes disconnected queued requests without running them and rejects only queue overflow', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const s = await service({ queueCapacity: 1 }, async () => {
      await hold;
      return answer();
    });
    const state = () =>
      fetch(`${s.url}/api/status`, {
        headers: { Authorization: `Bearer ${config.token}` },
      }).then((r) => r.json());
    const first = s.send();
    await vi.waitFor(async () =>
      expect(await state()).toMatchObject({ active: 1 }),
    );
    const controller = new AbortController();
    const second = s.send(prompt, {}, controller.signal).catch((e) => e);
    await vi.waitFor(async () =>
      expect(await state()).toMatchObject({ queued: 1 }),
    );
    const overflow = await s.send();
    expect(overflow.status).toBe(429);
    expect(await overflow.json()).toMatchObject({ code: 'queue_full' });
    controller.abort();
    await second;
    await vi.waitFor(async () =>
      expect(await state()).toMatchObject({ queued: 0 }),
    );
    const replacement = s.send();
    await vi.waitFor(async () =>
      expect(await state()).toMatchObject({ queued: 1 }),
    );
    release();
    expect((await first).status).toBe(200);
    expect((await replacement).status).toBe(200);
    expect(
      s.fetcher.mock.calls.filter(([url]) => url.endsWith('/api/chat')),
    ).toHaveLength(2);
  });
  it('expires waiting jobs without inference, then continues serving after an upstream failure', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const s = await service({ queueTimeoutMs: 40 }, async () => {
      calls++;
      if (calls === 1) {
        await hold;
        throw new Error('upstream failed');
      }
      return answer();
    });
    const first = s.send();
    await vi.waitFor(() => expect(calls).toBe(1));
    const expired = await s.send();
    expect(expired.status).toBe(504);
    expect(await expired.json()).toMatchObject({ code: 'queue_timeout' });
    expect(calls).toBe(1);
    release();
    expect((await first).status).toBe(503);
    expect((await s.send()).status).toBe(200);
  });
  it('aborts upstream when client disconnects and releases its slot', async () => {
    let started: () => void = () => {};
    let cancelled: () => void = () => {};
    const entered = new Promise<void>((r) => {
      started = r;
    });
    const aborted = new Promise<void>((r) => {
      cancelled = r;
    });
    const s = await service({}, async (_url, init) => {
      started();
      return new Promise<Response>((_resolve, reject) =>
        init.signal.addEventListener('abort', () => {
          cancelled();
          reject(init.signal.reason);
        }),
      );
    });
    const controller = new AbortController();
    const first = s.send(prompt, {}, controller.signal).catch((e) => e);
    await entered;
    controller.abort();
    await first;
    await aborted;
    const state = await fetch(`${s.url}/api/status`, {
      headers: { Authorization: `Bearer ${config.token}` },
    }).then((r) => r.json());
    expect(state).toMatchObject({ active: 0 });
  });
  it('times out hung upstream and reports malformed completion as failure', async () => {
    const s = await service(
      { timeoutMs: 30 },
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal.addEventListener('abort', () =>
            reject(init.signal.reason),
          ),
        ),
    );
    expect((await s.send()).status).toBe(504);
    const broken = await service({}, async () =>
      Response.json({ done: false, message: { content: 'part' } }),
    );
    expect((await broken.send()).status).toBe(503);
  });
  it('rejects large fixed and chunked request bodies', async () => {
    const s = await service({ maxBodyBytes: 100 });
    expect(
      (await s.send({ messages: [{ role: 'user', content: 'x'.repeat(200) }] }))
        .status,
    ).toBe(413);
    const result = await new Promise<number>((resolve, reject) => {
      const r = httpRequest(
        `${s.url}/api/chat`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.token}`,
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      r.on('error', reject);
      r.write('x'.repeat(200));
      r.end();
    });
    expect(result).toBe(413);
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('does not serve arbitrary files or expose upstream management endpoints', async () => {
    const s = await service();
    const html = await fetch(s.url);
    expect(html.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
    expect(await html.text()).toContain('Ключ доступа');
    for (const path of ['/api/pull', '/api/delete', '/config.mjs']) {
      expect(
        (
          await fetch(`${s.url}${path}`, {
            headers: { Authorization: `Bearer ${config.token}` },
          })
        ).status,
      ).toBe(404);
    }
  });
  it('rejects Ollama cloud aliases and non-chat models during verification', async () => {
    for (const data of [
      { remote_host: 'https://cloud', capabilities: ['completion'] },
      { capabilities: ['embedding'] },
    ]) {
      await expect(
        checkModel(config, async () => Response.json(data)),
      ).rejects.toThrow();
    }
  });
  it('reserves answer space and counts non-ASCII input conservatively', () => {
    const english = validateChat(
      { messages: [{ role: 'user', content: 'a'.repeat(700) }] },
      config,
    );
    const russian = validateChat(
      { messages: [{ role: 'user', content: 'я'.repeat(700) }] },
      config,
    );
    expect('error' in english).toBe(false);
    expect(russian).toMatchObject({ status: 413 });
    expect(
      validateChat(
        { messages: [{ role: 'assistant', content: 'bad' }] },
        config,
      ),
    ).toMatchObject({ status: 400 });
  });
});
