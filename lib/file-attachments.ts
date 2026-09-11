import type { ChatAttachmentKind } from '@/lib/chat-types';

export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024;
export const MAX_TOTAL_TEXT_ATTACHMENT_BYTES = 512 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_NAME_LENGTH = 255;

const IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const IMAGE_EXTENSIONS = new Set(['gif', 'jpeg', 'jpg', 'png', 'webp']);

const TEXT_MEDIA_TYPES = new Set([
  'application/json',
  'application/javascript',
  'application/sql',
  'application/xml',
  'application/x-httpd-php',
  'application/x-sh',
  'application/x-yaml',
  'application/yaml',
]);

const TEXT_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'csv',
  'go',
  'h',
  'hpp',
  'html',
  'java',
  'js',
  'jsx',
  'json',
  'kt',
  'log',
  'md',
  'php',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'svg',
  'toml',
  'ts',
  'tsx',
  'tsv',
  'txt',
  'xml',
  'yaml',
  'yml',
]);

export const ATTACHMENT_INPUT_ACCEPT = [
  ...IMAGE_MEDIA_TYPES,
  ...[...IMAGE_EXTENSIONS].map((extension) => `.${extension}`),
  ...[...TEXT_EXTENSIONS].map((extension) => `.${extension}`),
].join(',');

type FileDescriptor = Pick<File, 'name' | 'size' | 'type'>;

function extensionOf(name: string): string {
  const separator = name.lastIndexOf('.');
  return separator === -1 ? '' : name.slice(separator + 1).toLowerCase();
}

export function classifyAttachment(
  file: Pick<FileDescriptor, 'name' | 'type'>,
): ChatAttachmentKind | null {
  const mediaType = file.type.toLowerCase();

  if (
    IMAGE_MEDIA_TYPES.has(mediaType) ||
    IMAGE_EXTENSIONS.has(extensionOf(file.name))
  ) {
    return 'image';
  }
  if (
    mediaType.startsWith('text/') ||
    TEXT_MEDIA_TYPES.has(mediaType) ||
    TEXT_EXTENSIONS.has(extensionOf(file.name))
  ) {
    return 'text';
  }

  return null;
}

export function validateAttachmentFiles(
  files: FileDescriptor[],
): { ok: true } | { ok: false; message: string } {
  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return {
      ok: false,
      message: `Можно прикрепить не больше ${MAX_ATTACHMENTS_PER_MESSAGE} файлов.`,
    };
  }

  let totalBytes = 0;
  let totalTextBytes = 0;

  for (const file of files) {
    const name = file.name.trim();
    const kind = classifyAttachment(file);

    if (!name || name.length > MAX_ATTACHMENT_NAME_LENGTH) {
      return { ok: false, message: 'У одного из файлов некорректное имя.' };
    }
    if (file.size <= 0 || !Number.isSafeInteger(file.size)) {
      return { ok: false, message: `Файл «${name}» пуст или повреждён.` };
    }
    if (!kind) {
      return {
        ok: false,
        message: `Формат файла «${name}» не поддерживается. Прикрепите изображение или текстовый файл.`,
      };
    }

    const limit =
      kind === 'image' ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_TEXT_ATTACHMENT_BYTES;
    if (file.size > limit) {
      return {
        ok: false,
        message: `Файл «${name}» слишком большой. Максимум ${formatFileSize(limit)}.`,
      };
    }

    totalBytes += file.size;
    if (kind === 'text') totalTextBytes += file.size;
  }

  if (totalTextBytes > MAX_TOTAL_TEXT_ATTACHMENT_BYTES) {
    return {
      ok: false,
      message: `Суммарный размер текстовых файлов не должен превышать ${formatFileSize(MAX_TOTAL_TEXT_ATTACHMENT_BYTES)}.`,
    };
  }
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    return {
      ok: false,
      message: `Суммарный размер вложений не должен превышать ${formatFileSize(MAX_TOTAL_ATTACHMENT_BYTES)}.`,
    };
  }

  return { ok: true };
}

export function isDeepSeekFileId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 255 &&
    /^file-api-[A-Za-z0-9_-]+$/.test(value)
  );
}

export function isVisionModel(model: string): boolean {
  return model.toLowerCase().includes('flash');
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} КБ`;
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)} МБ`;
}
