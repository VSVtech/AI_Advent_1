'use client';
/* oxlint-disable next/no-html-link-for-pages -- Vinext has no Next Link package in the test runtime. */

import { ArrowLeft, UserRound } from 'lucide-react';
import { type SyntheticEvent, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  loadGeneralProfile,
  MAX_PROFILE_LENGTH,
  normalizeProfileText,
  saveGeneralProfile,
} from '@/lib/user-profile';

export default function GeneralProfilePage() {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setText(loadGeneralProfile(window.localStorage));
      setLoaded(true);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  const normalized = normalizeProfileText(text);
  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (normalized === null) return;
    const success = saveGeneralProfile(window.localStorage, normalized);
    setSaved(success);
    setSaveError(!success);
  };

  return (
    <main className="chat-shell">
      <div className="app-frame flex flex-col md:flex-row">
        <aside className="app-sidebar agent-sidebar" aria-label="Навигация">
          <div className="flex h-[68px] shrink-0 items-center gap-2.5 px-4">
            <span className="brand-mark shrink-0" aria-hidden="true">
              <UserRound className="size-[18px]" />
            </span>
            <span className="text-sm font-semibold text-white">
              General Profile
            </span>
          </div>
          <div className="agent-sidebar-body">
            <a
              href="/"
              className="flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm text-white/75 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              Вернуться к агентам
            </a>
          </div>
        </aside>

        <div className="section-panel flex-1">
          <div className="agent-setup">
            <header className="chat-header shrink-0">
              <div className="flex items-center gap-3">
                <span className="brand-mark shrink-0" aria-hidden="true">
                  <UserRound className="size-[18px]" />
                </span>
                <div>
                  <h1 className="text-sm font-semibold text-white">
                    General Profile
                  </h1>
                  <p className="text-xs text-white/40">
                    Общий профиль пользователя
                  </p>
                </div>
              </div>
            </header>

            <form className="agent-setup-form" onSubmit={handleSubmit}>
              <div className="mx-auto max-w-3xl space-y-4">
                <div className="space-y-2">
                  <h2 className="text-lg font-semibold text-white">
                    Информация о вас
                  </h2>
                  <p className="text-sm leading-6 text-white/55">
                    Опишите нужный стиль, формат и ограничения ответов. Агенты с
                    включённой настройкой «Использовать стандартный профиль»
                    получат актуальный текст при следующем запросе. Если поле
                    пустое, профиль не отправляется модели.
                  </p>
                </div>
                <div className="agent-setup-field">
                  <label
                    className="format-label"
                    htmlFor="general-profile-text"
                  >
                    Текст профиля
                  </label>
                  <Textarea
                    id="general-profile-text"
                    value={text}
                    maxLength={MAX_PROFILE_LENGTH}
                    disabled={!loaded}
                    aria-invalid={normalized === null || undefined}
                    placeholder="Например: я аналитик. Предпочитаю краткие ответы на русском, списки для сравнения, без непроверенных утверждений."
                    className="min-h-64 resize-y border-white/8 bg-white/[0.035] text-sm leading-6 text-white/80"
                    onChange={(event) => {
                      setText(event.target.value);
                      setSaved(false);
                      setSaveError(false);
                    }}
                  />
                  <p className="system-prompt-hint">
                    {text.length}/{MAX_PROFILE_LENGTH} символов. Хранится только
                    в этом браузере; не добавляйте пароли и API-ключи.
                  </p>
                </div>
                <p className="text-sm leading-6 text-white/50">
                  При конфликте с памятью агент опирается на текущий контекст, а
                  не на профиль.
                </p>
                {saveError ? (
                  <p role="alert" className="system-prompt-error">
                    Не удалось сохранить профиль в браузере.
                  </p>
                ) : null}
                {normalized === null ? (
                  <p role="alert" className="system-prompt-error">
                    Профиль не должен превышать {MAX_PROFILE_LENGTH} символов
                    или содержать управляющие символы.
                  </p>
                ) : null}
                <div className="flex items-center gap-3">
                  <Button
                    type="submit"
                    disabled={!loaded || normalized === null}
                  >
                    Сохранить профиль
                  </Button>
                  {saved ? (
                    <output className="text-sm text-emerald-300">
                      Сохранено
                    </output>
                  ) : null}
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
    </main>
  );
}
