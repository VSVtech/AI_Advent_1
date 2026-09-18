import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import GeneralProfilePage from '@/app/general-profile/page';

describe('страница General Profile', () => {
  it('показывает отдельную форму редактирования и ссылку обратно к агентам', () => {
    const markup = renderToStaticMarkup(<GeneralProfilePage />);

    expect(markup).toContain('General Profile');
    expect(markup).toContain('id="general-profile-text"');
    expect(markup).toContain('Сохранить профиль');
    expect(markup).toContain('href="/"');
    expect(markup).toContain('При конфликте с памятью');
  });
});
