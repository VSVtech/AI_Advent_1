import { describe, expect, it } from 'vitest';

import {
  buildUserProfileSystemPrompt,
  GENERAL_PROFILE_STORAGE_KEY,
  loadGeneralProfile,
  MAX_PROFILE_LENGTH,
  normalizeProfileText,
  saveGeneralProfile,
} from '@/lib/user-profile';

describe('профиль пользователя', () => {
  it('сохраняет и загружает общий профиль отдельно от сессий', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(loadGeneralProfile(storage)).toBe('');
    expect(saveGeneralProfile(storage, '  Кратко, в таблице  ')).toBe(true);
    expect(values.get(GENERAL_PROFILE_STORAGE_KEY)).toBe('Кратко, в таблице');
    expect(loadGeneralProfile(storage)).toBe('Кратко, в таблице');
    expect(saveGeneralProfile(storage, '')).toBe(true);
    expect(loadGeneralProfile(storage)).toBe('');
  });

  it('допускает пустой профиль, но отклоняет испорченный и слишком длинный', () => {
    expect(normalizeProfileText('  ')).toBe('');
    expect(normalizeProfileText(123)).toBeNull();
    expect(normalizeProfileText('A\u0000B')).toBeNull();
    expect(normalizeProfileText('x'.repeat(MAX_PROFILE_LENGTH + 1))).toBeNull();
  });

  it('различает профили и задаёт приоритет памяти при конфликте', () => {
    const concise = buildUserProfileSystemPrompt('Кратко, до 50 слов');
    const detailed = buildUserProfileSystemPrompt('Подробно, с примерами');

    expect(concise).toContain('Кратко, до 50 слов');
    expect(detailed).toContain('Подробно, с примерами');
    expect(concise).toContain('памяти при конфликте важнее данного профиля');
    expect(concise).not.toBe(detailed);
    expect(buildUserProfileSystemPrompt('')).toBeNull();
  });
});
