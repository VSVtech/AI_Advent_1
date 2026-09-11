import type { FileUploadResponsePayload } from '@/lib/chat-types';
import {
  classifyAttachment,
  isDeepSeekFileId,
  MAX_IMAGE_ATTACHMENT_BYTES,
  validateAttachmentFiles,
} from '@/lib/file-attachments';
import {
  DEEPSEEK_FILES_ENDPOINT,
  jsonError,
  mappedUpstreamError,
} from '@/lib/server/deepseek';

type DeepSeekFilePayload = {
  id?: unknown;
};

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

  if (!apiKey) {
    return jsonError(500, {
      code: 'configuration_error',
      message: 'DEEPSEEK_API_KEY не настроен. Добавьте токен в .env.local.',
    });
  }

  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return jsonError(400, {
      code: 'invalid_form_data',
      message: 'Не удалось прочитать загружаемый файл.',
    });
  }

  const file = formData.get('file');

  if (!(file instanceof File)) {
    return jsonError(400, {
      code: 'missing_file',
      message: 'Выберите файл для загрузки.',
    });
  }

  if (classifyAttachment(file) !== 'image') {
    return jsonError(400, {
      code: 'invalid_file',
      message: 'DeepSeek принимает как вложения только JPEG, PNG, GIF и WebP.',
    });
  }

  if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
    return jsonError(413, {
      code: 'file_too_large',
      message: 'Изображение слишком большое.',
    });
  }

  const validation = validateAttachmentFiles([file]);
  if (!validation.ok) {
    return jsonError(400, {
      code: 'invalid_file',
      message: validation.message,
    });
  }

  const upstreamForm = new FormData();
  upstreamForm.set('purpose', 'user_data');
  upstreamForm.set('file', file, file.name);

  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetch(DEEPSEEK_FILES_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstreamForm,
      cache: 'no-store',
      signal: request.signal,
    });
  } catch {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return jsonError(502, {
      code: 'deepseek_unreachable',
      message:
        'Не удалось загрузить файл в DeepSeek. Проверьте подключение к интернету.',
    });
  }

  if (!upstreamResponse.ok) return mappedUpstreamError(upstreamResponse);

  let payload: DeepSeekFilePayload;

  try {
    payload = (await upstreamResponse.json()) as DeepSeekFilePayload;
  } catch {
    return jsonError(502, {
      code: 'invalid_file_response',
      message: 'DeepSeek вернул некорректный ответ при загрузке файла.',
    });
  }

  if (!isDeepSeekFileId(payload.id)) {
    return jsonError(502, {
      code: 'invalid_file_response',
      message: 'DeepSeek не вернул идентификатор загруженного файла.',
    });
  }

  return Response.json(
    {
      file: {
        fileId: payload.id,
        name: file.name,
        mediaType: file.type,
        size: file.size,
      },
    } satisfies FileUploadResponsePayload,
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
