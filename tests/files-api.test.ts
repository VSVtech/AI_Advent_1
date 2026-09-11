import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/files/route';
import { MAX_IMAGE_ATTACHMENT_BYTES } from '@/lib/file-attachments';

const originalApiKey = process.env.DEEPSEEK_API_KEY;

function uploadRequest(file?: File): Request {
  const formData = new FormData();
  if (file) formData.set('file', file, file.name);
  return new Request('http://localhost/api/files', {
    method: 'POST',
    body: formData,
  });
}

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalApiKey;
  vi.unstubAllGlobals();
});

describe('POST /api/files', () => {
  it('не запускается без серверного токена', async () => {
    delete process.env.DEEPSEEK_API_KEY;

    const response = await POST(
      uploadRequest(new File(['image'], 'picture.png', { type: 'image/png' })),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'configuration_error' },
    });
  });

  it('отклоняет отсутствие файла и неподдерживаемый формат', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const missingResponse = await POST(uploadRequest());
    const textResponse = await POST(
      uploadRequest(new File(['text'], 'notes.txt', { type: 'text/plain' })),
    );

    expect(missingResponse.status).toBe(400);
    expect(textResponse.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('отклоняет слишком большое изображение до обращения к DeepSeek', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(
      [new Uint8Array(MAX_IMAGE_ATTACHMENT_BYTES + 1)],
      'large.png',
      { type: 'image/png' },
    );

    const response = await POST(uploadRequest(file));

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('загружает изображение в DeepSeek Files API и возвращает безопасные метаданные', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: 'file-api-picture-1',
        object: 'file',
        filename: 'picture.png',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['image'], 'picture.png', { type: 'image/png' });

    const response = await POST(uploadRequest(file));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      file: {
        fileId: 'file-api-picture-1',
        name: 'picture.png',
        mediaType: 'image/png',
        size: 5,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/files');
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer test-secret',
    );
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('purpose')).toBe('user_data');
    expect(((init.body as FormData).get('file') as File).name).toBe(
      'picture.png',
    );
  });

  it('не принимает ответ DeepSeek без file_id', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));

    const response = await POST(
      uploadRequest(new File(['image'], 'picture.png', { type: 'image/png' })),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_file_response' },
    });
  });
});
