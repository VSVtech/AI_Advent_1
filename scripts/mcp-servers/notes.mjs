// Local MCP server «Заметки»: saves agent results as Markdown files.
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from '@modelcontextprotocol/server';

import { errorResult, listenMcp, portFromEnv, textResult } from './listen.mjs';

export const DEFAULT_NOTES_DIR = fileURLToPath(
  new URL('../../.local-data/notes', import.meta.url),
);
const NOTE_ID = /^[a-z0-9-]{1,100}$/u;
const MAX_CONTENT_LENGTH = 20_000;
const TRANSLIT = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

function slugify(title) {
  const slug = [...title.toLocaleLowerCase('ru-RU')]
    .map((char) => TRANSLIT[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60)
    .replace(/-+$/u, '');
  return slug || 'note';
}

function notePath(notesDir, id) {
  return join(notesDir, `${id}.md`);
}

function titleOf(markdown) {
  return /^# (.+)$/mu.exec(markdown)?.[1] ?? 'Без названия';
}

export async function saveNote({ title, content }, notesDir, now = new Date()) {
  const cleanTitle = title.trim();
  // The file gets the title as its heading; a repeated one in the text is dropped.
  const [firstLine, ...rest] = content.trim().split('\n');
  const body = (
    firstLine.replace(/^#\s+/u, '').trim() === cleanTitle
      ? rest.join('\n')
      : content
  ).trim();
  if (!cleanTitle || cleanTitle.length > 120) {
    throw new Error('Название заметки: от 1 до 120 символов');
  }
  if (!body || body.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Текст заметки: от 1 до ${MAX_CONTENT_LENGTH} символов`);
  }
  const id = `${now.toISOString().slice(0, 10)}-${slugify(cleanTitle)}-${randomUUID().slice(0, 6)}`;
  const markdown = `# ${cleanTitle}\n\n_Сохранено агентом: ${now.toISOString()}_\n\n${body}\n`;
  await mkdir(notesDir, { recursive: true, mode: 0o700 });
  const temporaryPath = `${notePath(notesDir, id)}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, markdown, { mode: 0o600 });
  await rename(temporaryPath, notePath(notesDir, id));
  return {
    id,
    title: cleanTitle,
    savedAt: now.toISOString(),
    bytes: Buffer.byteLength(markdown),
  };
}

export async function listNotes(notesDir) {
  let names;
  try {
    names = await readdir(notesDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const notes = await Promise.all(
    names
      .filter(
        (name) =>
          NOTE_ID.test(name.replace(/\.md$/u, '')) && name.endsWith('.md'),
      )
      .map(async (name) => {
        const path = join(notesDir, name);
        const [markdown, info] = await Promise.all([
          readFile(path, 'utf8'),
          stat(path),
        ]);
        return {
          id: name.replace(/\.md$/u, ''),
          title: titleOf(markdown),
          savedAt: info.mtime.toISOString(),
          bytes: info.size,
        };
      }),
  );
  return notes
    .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
    .slice(0, 20);
}

export async function readNote(id, notesDir) {
  if (!NOTE_ID.test(id)) throw new Error('Некорректный id заметки');
  try {
    const markdown = await readFile(notePath(notesDir, id), 'utf8');
    return { id, title: titleOf(markdown), content: markdown };
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Заметка ${id} не найдена`);
    throw error;
  }
}

export function createNotesMcpHandler({
  notesDir = process.env.NOTES_DIR ?? DEFAULT_NOTES_DIR,
} = {}) {
  return createMcpHandler(() => {
    const mcp = new McpServer({ name: 'ai-challenge-notes', version: '1.0.0' });
    mcp.registerTool(
      'save_note',
      {
        description:
          'Сохранить результат в заметку: Markdown-файл на компьютере пользователя. ' +
          'Заголовок из title сервер добавит сам, в content его не повторяй. Возвращает id заметки.',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            title: {
              type: 'string',
              minLength: 1,
              maxLength: 120,
              description: 'Название заметки',
            },
            content: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_CONTENT_LENGTH,
              description: 'Текст заметки в Markdown',
            },
          },
          required: ['title', 'content'],
          additionalProperties: false,
        }),
      },
      async (args) => {
        try {
          return textResult(await saveNote(args, notesDir));
        } catch (error) {
          return errorResult(error, 'Не удалось сохранить заметку');
        }
      },
    );
    mcp.registerTool(
      'list_notes',
      { description: 'Показать последние сохранённые заметки' },
      async () => {
        try {
          return textResult({ notes: await listNotes(notesDir) });
        } catch (error) {
          return errorResult(error, 'Не удалось прочитать заметки');
        }
      },
    );
    mcp.registerTool(
      'read_note',
      {
        description: 'Прочитать сохранённую заметку по id',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            id: {
              type: 'string',
              pattern: '^[a-z0-9-]{1,100}$',
              description: 'id заметки из save_note или list_notes',
            },
          },
          required: ['id'],
          additionalProperties: false,
        }),
      },
      async ({ id }) => {
        try {
          return textResult(await readNote(id, notesDir));
        } catch (error) {
          return errorResult(error, 'Не удалось прочитать заметку');
        }
      },
    );
    return mcp;
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await listenMcp(createNotesMcpHandler(), {
    name: 'Notes',
    port: portFromEnv('MCP_NOTES_PORT', 18802),
  });
}
