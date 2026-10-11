import { readFileSync } from 'node:fs';

function integer(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}: expected integer ${min}..${max}`);
  return value;
}

export function configuration(env = process.env) {
  const url = new URL(env.PRIVATE_LLM_OLLAMA_URL ?? 'http://127.0.0.1:11435');
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'Ollama must be on loopback, without credentials or a path.',
    );
  const model = env.PRIVATE_LLM_MODEL ?? 'qwen2.5:0.5b';
  if (!/^[a-zA-Z0-9_.:/-]{1,100}$/.test(model) || /cloud/i.test(model))
    throw new Error('Invalid local model.');
  const token = readFileSync(
    env.PRIVATE_LLM_TOKEN_FILE ?? '.local-data/private-llm/token',
    'utf8',
  ).trim();
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error('API key must be 32 random bytes in hex.');
  const config = {
    host: '127.0.0.1',
    port: integer(env, 'PRIVATE_LLM_PORT', 18804, 1024, 65535),
    ollamaURL: url.origin,
    model,
    token,
    contextTokens: integer(env, 'PRIVATE_LLM_CONTEXT', 2048, 512, 32768),
    maxOutputTokens: integer(env, 'PRIVATE_LLM_MAX_OUTPUT', 256, 16, 4096),
    requestsPerMinute: integer(env, 'PRIVATE_LLM_RPM', 8, 1, 120),
    concurrency: integer(env, 'PRIVATE_LLM_CONCURRENCY', 1, 1, 4),
    queueCapacity: integer(env, 'PRIVATE_LLM_QUEUE_CAPACITY', 4, 1, 32),
    queueTimeoutMs: integer(
      env,
      'PRIVATE_LLM_QUEUE_TIMEOUT_MS',
      120000,
      1000,
      600000,
    ),
    timeoutMs: integer(env, 'PRIVATE_LLM_TIMEOUT_MS', 120000, 1000, 300000),
    maxBodyBytes: 65536,
  };
  if (config.maxOutputTokens + 384 >= config.contextTokens)
    throw new Error('Context must leave room for input and output.');
  return config;
}

export const SYSTEM_PROMPT =
  'Отвечай кратко и по существу на языке пользователя. Если не знаешь, так и скажи. Не выдумывай источники.';

export function validateChat(body, config) {
  const fail = (status, code, error) => ({ status, code, error });
  if (
    !body ||
    Array.isArray(body) ||
    typeof body !== 'object' ||
    Object.keys(body).some(
      (key) =>
        !['messages', 'temperature', 'max_tokens', 'context_tokens'].includes(
          key,
        ),
    )
  )
    return fail(
      400,
      'invalid_request',
      'Допустимы только messages, temperature, max_tokens и context_tokens. Модель задаёт сервер.',
    );
  const { messages } = body;
  if (
    !Array.isArray(messages) ||
    !messages.length ||
    messages.length > 24 ||
    messages.some(
      (m, index) =>
        !m ||
        typeof m.content !== 'string' ||
        !m.content.trim() ||
        m.role !== (index % 2 === 0 ? 'user' : 'assistant'),
    ) ||
    messages.at(-1).role !== 'user'
  )
    return fail(
      400,
      'invalid_history',
      'Нужна история до 24 сообщений: user/assistant по очереди, последнее — user.',
    );
  const temperature = body.temperature ?? 0;
  const context = body.context_tokens ?? config.contextTokens;
  const output = body.max_tokens ?? config.maxOutputTokens;
  if (
    !Number.isFinite(temperature) ||
    temperature < 0 ||
    temperature > 2 ||
    !Number.isInteger(context) ||
    context < 512 ||
    context > config.contextTokens ||
    !Number.isInteger(output) ||
    output < 1 ||
    output > config.maxOutputTokens
  )
    return fail(
      400,
      'invalid_limits',
      'Параметры превышают ограничения сервера.',
    );
  const cleanMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages.map(({ role, content }) => ({ role, content })),
  ];
  // A deliberately conservative admission budget: at most one token per UTF-8
  // byte, plus role/template overhead and an output reservation. Not a tokenizer.
  const inputBudget = cleanMessages.reduce(
    (n, m) => n + Buffer.byteLength(m.content, 'utf8') + 32,
    256,
  );
  if (inputBudget + output > context)
    return fail(
      413,
      'context_limit',
      'История не помещается в окно с резервом ответа. Начните новый чат или сократите вопрос.',
    );
  return { messages: cleanMessages, temperature, context, output, inputBudget };
}
