const element = (id) => document.getElementById(id);
let token = '',
  messages = [],
  controller = null;
const setStatus = (text) => {
  element('status').textContent = text;
};
async function api(path, body, signal) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      `${data.error ?? 'Ошибка сервиса'}${response.headers.get('Retry-After') ? ` Повтор через ${response.headers.get('Retry-After')} с.` : ''}`,
    );
  return data;
}
function render() {
  element('messages').replaceChildren();
  for (const message of messages) {
    const card = document.createElement('article');
    card.className = message.role;
    const label = document.createElement('strong');
    label.textContent = message.role === 'user' ? 'Вы' : 'Модель';
    const text = document.createElement('p');
    text.textContent = message.content;
    card.append(label, text);
    element('messages').append(card);
  }
}
element('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  token = element('token').value.trim();
  try {
    const data = await api('/api/status');
    element('token').value = '';
    element('model').textContent = `${data.model} · локальная на VPS`;
    element('limits').textContent =
      `Контекст: ${data.contextTokens} · Ответ: до ${data.maxOutputTokens} токенов · ${data.requestsPerMinute} запросов/мин · Генераций одновременно: ${data.concurrency} · Мест в очереди: ${data.queueCapacity}`;
    element('login').hidden = true;
    element('chat').hidden = false;
    setStatus('Подключено.');
    element('question').focus();
  } catch (error) {
    token = '';
    setStatus(error.message);
  }
});
element('compose').addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = element('question').value.trim();
  if (!question || controller) return;
  controller = new AbortController();
  const prior = messages.slice();
  messages.push({ role: 'user', content: question });
  render();
  element('question').value = '';
  for (const id of ['send', 'reset', 'logout']) element(id).disabled = true;
  element('cancel').hidden = false;
  setStatus('Запрос отправлен: генерация или ожидание очереди…');
  const pending = controller;
  const polling = new AbortController();
  let statusTimer;
  const pollQueue = async () => {
    try {
      const state = await api('/api/status', undefined, polling.signal);
      if (!polling.signal.aborted && controller === pending)
        setStatus(
          `Запрос выполняется или ожидает своей очереди. На сервере: генераций ${state.active}, ожидают ${state.queued}.`,
        );
    } catch {
      /* A status poll must not interrupt generation. */
    }
    if (!polling.signal.aborted) statusTimer = setTimeout(pollQueue, 1000);
  };
  statusTimer = setTimeout(pollQueue, 500);
  try {
    const result = await api('/api/chat', { messages }, controller.signal);
    messages.push(result.message);
    render();
    setStatus(
      `${result.seconds} с · ожидание очереди ${result.queueWaitSeconds ?? 0} с · ${result.usage.outputTokens ?? '—'} токенов${result.finishReason === 'length' ? ' · Достигнут лимит ответа; ответ может быть неполным.' : ''}`,
    );
    element('compose').scrollIntoView({ behavior: 'smooth', block: 'end' });
  } catch (error) {
    messages = prior;
    element('question').value = question;
    render();
    setStatus(
      error.name === 'AbortError' ? 'Генерация остановлена.' : error.message,
    );
  } finally {
    polling.abort();
    clearTimeout(statusTimer);
    controller = null;
    for (const id of ['send', 'reset', 'logout']) element(id).disabled = false;
    element('cancel').hidden = true;
    element('question').focus();
  }
});
element('question').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    element('compose').requestSubmit();
  }
});
element('cancel').onclick = () => controller?.abort();
element('reset').onclick = () => {
  messages = [];
  render();
  setStatus('Новый диалог.');
};
element('logout').onclick = () => {
  token = '';
  messages = [];
  render();
  element('question').value = '';
  element('chat').hidden = true;
  element('login').hidden = false;
  setStatus('Вы вышли.');
};
