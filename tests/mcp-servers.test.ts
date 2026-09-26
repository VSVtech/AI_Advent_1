import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { listNotes, readNote, saveNote } from '@/scripts/mcp-servers/notes.mjs';
import { estimateTrip, planTrip } from '@/scripts/mcp-servers/travel.mjs';
import { CITIES, createGeocodingStub } from '@/tests/helpers/geocoding';

const geocodingStub = createGeocodingStub();

const temporaryDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true })),
  );
});

test('«Поездки»: оценка дороги по расстоянию и рекомендуемый вариант', () => {
  expect(estimateTrip(CITIES.Берлин, CITIES.Потсдам)).toEqual({
    distanceKm: 27,
    roadDistanceKm: 34,
    options: [
      { mode: 'train', label: 'Поезд', hours: 1 },
      { mode: 'car', label: 'Автомобиль', hours: 0.5 },
    ],
    recommended: 'car',
  });
  expect(estimateTrip(CITIES.Москва, CITIES.Потсдам)).toMatchObject({
    distanceKm: 1635,
    recommended: 'plane',
  });
});

test('«Поездки»: plan_trip геокодирует оба города и считает дни до поездки', async () => {
  const trip = await planTrip(
    { from: 'Берлин', to: 'Потсдам', date: '2026-10-10' },
    { fetchImpl: geocodingStub, now: new Date('2026-09-26T12:00:00Z') },
  );
  expect(trip).toMatchObject({
    from: { name: 'Берлин', country: 'Германия' },
    to: { name: 'Потсдам', country: 'Германия' },
    date: '2026-10-10',
    daysUntil: 14,
    distanceKm: 27,
  });
  await expect(
    planTrip({ from: 'Нигде', to: 'Потсдам' }, { fetchImpl: geocodingStub }),
  ).rejects.toThrow('Город «Нигде» не найден');
});

test('«Заметки»: сохраняет Markdown-файл, показывает список и читает по id', async () => {
  const notesDir = await mkdtemp(join(tmpdir(), 'notes-'));
  temporaryDirs.push(notesDir);
  const saved = await saveNote(
    {
      title: 'Поездка на концерт Нюша',
      content: '## План\n\nПотсдам, 10 октября',
    },
    notesDir,
    new Date('2026-09-26T12:00:00Z'),
  );
  expect(saved.id).toMatch(
    /^2026-09-26-poezdka-na-kontsert-nyusha-[a-f0-9]{6}$/u,
  );
  const markdown = await readFile(join(notesDir, `${saved.id}.md`), 'utf8');
  expect(markdown).toContain('# Поездка на концерт Нюша');
  expect(markdown).toContain('Потсдам, 10 октября');
  expect(saved.bytes).toBe(Buffer.byteLength(markdown));

  expect(await listNotes(notesDir)).toMatchObject([
    { id: saved.id, title: 'Поездка на концерт Нюша' },
  ]);
  await expect(readNote(saved.id, notesDir)).resolves.toMatchObject({
    title: 'Поездка на концерт Нюша',
    content: markdown,
  });
  await expect(readNote('../secret', notesDir)).rejects.toThrow(
    'Некорректный id',
  );
  await expect(
    saveNote({ title: ' ', content: 'x' }, notesDir),
  ).rejects.toThrow('Название заметки');

  const repeated = await saveNote(
    { title: 'Итог', content: '# Итог\n\nТекст' },
    notesDir,
  );
  const repeatedMarkdown = (await readNote(repeated.id, notesDir)).content;
  expect(repeatedMarkdown.match(/^# Итог$/gmu)).toHaveLength(1);
  expect(repeatedMarkdown).toContain('Текст');
});
