import { describe, expect, it } from 'vitest';

import {
  classifyAttachment,
  formatFileSize,
  isDeepSeekFileId,
  isVisionModel,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TEXT_ATTACHMENT_BYTES,
  validateAttachmentFiles,
} from '@/lib/file-attachments';

function file(name: string, type: string, size = 10) {
  return { name, type, size };
}

describe('ограничения файлов', () => {
  it('распознаёт изображения и текстовые файлы', () => {
    expect(classifyAttachment(file('picture.png', 'image/png'))).toBe('image');
    expect(classifyAttachment(file('notes.txt', 'text/plain'))).toBe('text');
    expect(classifyAttachment(file('config.yaml', ''))).toBe('text');
    expect(
      classifyAttachment(file('document.pdf', 'application/pdf')),
    ).toBeNull();
  });

  it('отклоняет слишком много файлов и слишком большой текстовый файл', () => {
    expect(
      validateAttachmentFiles(
        Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, index) =>
          file(`${index}.txt`, 'text/plain'),
        ),
      ),
    ).toMatchObject({ ok: false });
    expect(
      validateAttachmentFiles([
        file('large.txt', 'text/plain', MAX_TEXT_ATTACHMENT_BYTES + 1),
      ]),
    ).toMatchObject({ ok: false });
  });

  it('проверяет file_id и поддержку изображений моделью', () => {
    expect(isDeepSeekFileId('file-api-picture_123')).toBe(true);
    expect(isDeepSeekFileId('file-other-123')).toBe(false);
    expect(isVisionModel('deepseek-flash')).toBe(true);
    expect(isVisionModel('deepseek-v4-flash')).toBe(true);
    expect(isVisionModel('deepseek-v4-pro')).toBe(false);
  });

  it('форматирует размер файла', () => {
    expect(formatFileSize(900)).toBe('900 Б');
    expect(formatFileSize(2048)).toBe('2 КБ');
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 МБ');
  });
});
