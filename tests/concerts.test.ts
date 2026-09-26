import { expect, test } from 'vitest';

import { CONCERTS, findConcerts, PERFORMERS } from '@/scripts/mcp/concerts.mjs';

test('афиша: у каждого смешарика один концерт в городе Германии', () => {
  expect(PERFORMERS).toEqual([
    'Крош',
    'Ёжик',
    'Нюша',
    'Бараш',
    'Лосяш',
    'Копатыч',
    'Совунья',
    'Кар-Карыч',
    'Пин',
    'Биби',
    'Пандочка',
  ]);
  expect(new Set(CONCERTS.map((concert) => concert.city)).size).toBe(
    CONCERTS.length,
  );
  for (const concert of CONCERTS) {
    expect(concert.country).toBe('Германия');
    expect(concert.date).toMatch(/^2026-\d{2}-\d{2}$/u);
    expect(Number.isNaN(Date.parse(concert.date))).toBe(false);
    expect(concert.venue.length).toBeGreaterThan(3);
  }
  // Names the Open-Meteo geocoder resolves outside Germany or not at all.
  expect(CONCERTS.map((concert) => concert.city)).not.toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^(Гейдельберг|Фрайбург|Аахен)$/u),
    ]),
  );
});

test('находит исполнителя в любом падеже, с «ё» и без', () => {
  const city = (query: string) =>
    findConcerts(query).concerts.map((concert) => concert.city);

  expect(findConcerts('Нюша')).toMatchObject({
    found: true,
    concerts: [
      {
        performer: 'Нюша',
        city: 'Потсдам',
        country: 'Германия',
        date: '2026-10-10',
      },
    ],
  });
  expect(city('нюши')).toEqual(['Потсдам']);
  expect(city('Нюшей')).toEqual(['Потсдам']);
  expect(city('ежика')).toEqual(['Киль']);
  expect(city('Крошем')).toEqual(['Майнц']);
  expect(city('Кар-Карыча')).toEqual(['Йена']);
  expect(city('Совуньи')).toEqual(['Вюрцбург']);
  expect(city('Пину')).toEqual(['Эрфурт']);
});

test('не путает похожие слова и подсказывает список исполнителей', () => {
  for (const query of ['Кролик', 'Чебурашка', 'Н', '']) {
    expect(findConcerts(query)).toEqual({
      query,
      found: false,
      concerts: [],
      knownPerformers: [...PERFORMERS],
    });
  }
  expect(findConcerts().concerts).toHaveLength(PERFORMERS.length);
});
