// Agent skills: recipes that chain MCP tools for a composite request. A skill
// is offered to the model only when every tool of its chain is available.
export type AgentSkill = {
  id: string;
  name: string;
  description: string;
  tools: readonly string[];
  instructions: string;
};

export const AGENT_SKILLS: readonly AgentSkill[] = [
  {
    id: 'concert-weather',
    name: 'Погода на концерте',
    description:
      'Узнаёт погоду в городе, где выступает исполнитель из афиши: сначала находит город концерта, затем запрашивает погоду в нём.',
    tools: ['find_concert', 'get_weather'],
    instructions: [
      'Используй, когда спрашивают о погоде там, где выступает исполнитель, например: «Какая погода, где выступает Нюша?» или «Нужен ли зонт на концерт Кроша?».',
      '1. Вызови find_concert, передав имя исполнителя в именительном падеже.',
      '2. Возьми поле city из найденного концерта и вызови get_weather ровно с этим значением: не угадывай город и не подставляй другой.',
      '3. Ответь, кто, где и когда выступает и какая там сейчас погода.',
      'Если find_concert ничего не нашёл, не вызывай get_weather: скажи, что концерта нет, и перечисли исполнителей из поля knownPerformers. Если концертов несколько, узнай погоду для каждого города.',
    ].join('\n'),
  },
  {
    id: 'concert-trip',
    name: 'Поездка на концерт',
    description:
      'Планирует поездку на концерт через три MCP-сервера: афиша и погода на капсуле, дорога в «Поездках», итоговый план в «Заметках».',
    tools: ['find_concert', 'get_weather', 'plan_trip', 'save_note'],
    instructions: [
      'Используй, когда просят спланировать поездку на концерт исполнителя, например: «Спланируй поездку на концерт Нюши из Берлина и сохрани план».',
      '1. Вызови find_concert с именем исполнителя: он даст город, дату и площадку.',
      '2. Затем вызови get_weather с city концерта и plan_trip с from = городом отправления из запроса, to = city концерта, date = датой концерта. Эти два вызова можно сделать одновременно.',
      '3. Вызови save_note: title — «Поездка на концерт <исполнитель>», content — план в Markdown: концерт (дата, город, площадка), погода сейчас, дорога (расстояние, варианты и рекомендация, сколько дней до поездки).',
      '4. Коротко ответь пользователю и назови id сохранённой заметки.',
      'Не вызывай save_note раньше, чем получены данные шагов 1–2. Если город отправления не назван, спроси его и не вызывай plan_trip. Если концерт не найден, не вызывай остальные инструменты.',
    ].join('\n'),
  },
];

export function availableSkills(toolNames: readonly string[]): AgentSkill[] {
  return AGENT_SKILLS.filter((skill) =>
    skill.tools.every((tool) => toolNames.includes(tool)),
  );
}

export function buildSkillsPrompt(toolNames: readonly string[]): string | null {
  const skills = availableSkills(toolNames);
  if (skills.length === 0) return null;
  return [
    'Скиллы агента — готовые цепочки MCP-инструментов. Если запрос подходит под скилл, выполни все его шаги сам, не спрашивая пользователя.',
    ...skills.map(
      (skill) =>
        `Скилл «${skill.name}» (${skill.tools.join(' → ')}):\n${skill.instructions}`,
    ),
  ].join('\n\n');
}
