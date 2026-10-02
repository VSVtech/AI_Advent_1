import {
  mkdir,
  readFile,
  rename,
  writeFile,
  open,
  unlink,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeVector } from './embeddings.mjs';

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function withBuildLock(directory, action) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'build.lock');
  let lock;
  try {
    lock = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'Индексация уже запущена. Если процесс аварийно завершился, удалите .local-data/rag/build.lock.',
      );
    throw error;
  }
  try {
    await lock.writeFile(
      JSON.stringify({
        pid: process.pid,
        started_at: new Date().toISOString(),
      }),
    );
    return await action();
  } finally {
    await lock.close();
    await unlink(path);
  }
}

export async function readCurrent(directory) {
  try {
    const current = await readJson(join(directory, 'current.json'));
    if (!/^[a-zA-Z0-9-]+$/u.test(current.build_id))
      throw new Error('Некорректный идентификатор сборки.');
    return current;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function loadIndex(directory, buildId, strategy) {
  if (
    !/^[a-zA-Z0-9-]+$/u.test(buildId) ||
    !['fixed', 'overlap', 'structure'].includes(strategy)
  )
    throw new Error('Некорректный индекс.');
  const index = await readJson(
    join(directory, 'builds', buildId, `${strategy}.json`),
  );
  if (
    index.manifest?.schema_version !== 1 ||
    !Array.isArray(index.chunks) ||
    !index.chunks.length ||
    !Number.isInteger(index.manifest.dimensions) ||
    index.manifest.dimensions <= 0
  )
    throw new Error('Повреждённый индекс.');
  const ids = new Set();
  for (const chunk of index.chunks) {
    if (
      !chunk.text ||
      !chunk.source ||
      !chunk.chunk_id ||
      ids.has(chunk.chunk_id) ||
      chunk.embedding?.length !== index.manifest.dimensions
    )
      throw new Error('Повреждённый чанк.');
    normalizeVector(chunk.embedding);
    ids.add(chunk.chunk_id);
  }
  return index;
}
