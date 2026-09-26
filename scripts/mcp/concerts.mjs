export const COUNTRY = 'Германия';

// Local hardcoded concert listing: Smeshariki perform in random German cities.
// City names are ones the Open-Meteo geocoder resolves to Germany: e.g. it
// finds «Гейдельберг» in South Africa and «Фрайбург» as a small village.
export const CONCERTS = Object.freeze(
  [
    {
      performer: 'Крош',
      city: 'Майнц',
      date: '2026-10-03',
      venue: 'Рейнская набережная, открытая сцена',
    },
    {
      performer: 'Ёжик',
      city: 'Киль',
      date: '2026-10-08',
      venue: 'Портовый концертный зал',
    },
    {
      performer: 'Нюша',
      city: 'Потсдам',
      date: '2026-10-10',
      venue: 'Дворцовый парк, летняя сцена',
    },
    {
      performer: 'Бараш',
      city: 'Бамберг',
      date: '2026-10-14',
      venue: 'Зал камерной музыки',
    },
    {
      performer: 'Лосяш',
      city: 'Кобленц',
      date: '2026-10-17',
      venue: 'Крепостной двор',
    },
    {
      performer: 'Копатыч',
      city: 'Констанц',
      date: '2026-10-21',
      venue: 'Сцена у Боденского озера',
    },
    {
      performer: 'Совунья',
      city: 'Вюрцбург',
      date: '2026-10-24',
      venue: 'Концертный зал Резиденции',
    },
    {
      performer: 'Кар-Карыч',
      city: 'Йена',
      date: '2026-10-29',
      venue: 'Планетарий',
    },
    {
      performer: 'Пин',
      city: 'Эрфурт',
      date: '2026-11-01',
      venue: 'Соборная площадь',
    },
    {
      performer: 'Биби',
      city: 'Регенсбург',
      date: '2026-11-05',
      venue: 'Дом культуры',
    },
    {
      performer: 'Пандочка',
      city: 'Веймар',
      date: '2026-11-08',
      venue: 'Театральная площадь',
    },
  ].map((concert) => Object.freeze({ ...concert, country: COUNTRY })),
);

export const PERFORMERS = Object.freeze(
  CONCERTS.map((concert) => concert.performer),
);

function normalize(value) {
  return value
    .toLocaleLowerCase('ru-RU')
    .replaceAll('ё', 'е')
    .replace(/[^a-zа-я0-9]/gu, '');
}

// Russian case forms change only the ending: «Нюши», «Крошем», «Кар-Карыча».
function matchesPerformer(name, query) {
  const target = normalize(name);
  const probe = normalize(query);
  if (!probe) return false;
  if (probe === target) return true;
  let common = 0;
  while (
    common < target.length &&
    common < probe.length &&
    target[common] === probe[common]
  ) {
    common += 1;
  }
  return (
    common >= Math.max(3, target.length - 1) &&
    /^[аеиоуыэюяйьмх]{0,3}$/u.test(probe.slice(common))
  );
}

export function findConcerts(performer) {
  if (performer === undefined) {
    return { found: true, concerts: [...CONCERTS] };
  }
  const query = typeof performer === 'string' ? performer.trim() : '';
  const concerts = CONCERTS.filter((concert) =>
    matchesPerformer(concert.performer, query),
  );
  return concerts.length > 0
    ? { query, found: true, concerts }
    : { query, found: false, concerts: [], knownPerformers: [...PERFORMERS] };
}
