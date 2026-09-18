export type AgentProfileMode = 'general' | 'custom';

export const GENERAL_PROFILE_STORAGE_KEY = 'deepseek-chat:general-profile:v1';
export const MAX_PROFILE_LENGTH = 4000;

export function isAgentProfileMode(value: unknown): value is AgentProfileMode {
  return value === 'general' || value === 'custom';
}

/** Empty text means no profile; malformed text is rejected, not forwarded. */
export function normalizeProfileText(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length > MAX_PROFILE_LENGTH ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return (
        (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
      );
    })
  ) {
    return null;
  }
  return value.trim();
}

export function loadGeneralProfile(storage: Pick<Storage, 'getItem'>): string {
  try {
    return (
      normalizeProfileText(
        storage.getItem(GENERAL_PROFILE_STORAGE_KEY) ?? '',
      ) ?? ''
    );
  } catch {
    return '';
  }
}

export function saveGeneralProfile(
  storage: Pick<Storage, 'setItem'>,
  text: string,
): boolean {
  const normalized = normalizeProfileText(text);
  if (normalized === null) return false;
  try {
    storage.setItem(GENERAL_PROFILE_STORAGE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

export function buildUserProfileSystemPrompt(text: string): string | null {
  const profile = normalizeProfileText(text);
  if (!profile) return null;
  return [
    'Профиль пользователя — предпочтения по умолчанию, а не источник фактов текущей задачи. Учитывай его стиль, формат и ограничения, только если они не противоречат памяти. Краткосрочная и рабочая память переданы отдельным первым сообщением input; долговременная память приведена ниже в instructions. Все эти слои памяти при конфликте важнее данного профиля. Например, если профиль требует английский, а сессионная память — русский, отвечай на русском. Последний явный запрос пользователя имеет наивысший приоритет; профиль не отменяет технически заданный JSON, XML или YAML.',
    `Текст профиля (JSON):\n${JSON.stringify(profile)}`,
  ].join('\n\n');
}
