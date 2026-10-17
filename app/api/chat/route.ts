import {
  isLocalModel,
  localModelName,
  LOCAL_CONTEXT_TOKENS,
} from '@/lib/model-provider';
import { generateLocalChat, ollamaEndpoint } from '@/lib/server/ollama';
import {
  isLocalRagProfile,
  LOCAL_RAG_PROFILES,
  localRagPrompt,
  localRagFormat,
  localRagContext,
} from '@/lib/local-rag-profile';
import {
  GROUNDING_PROMPT,
  passesGroundingThreshold,
} from '@/scripts/rag/grounding.mjs';
import {
  enforceGroundedResponse,
  unknownGroundedResponse,
} from '@/lib/server/rag-grounding';
import {
  prepareDialogueQuestion,
  renderDialogueContext,
} from '@/lib/server/rag-dialogue';
import { isRagSearchOptions } from '@/scripts/rag/relevance.mjs';
import {
  RAG_INSTRUCTIONS,
  EMPTY_RAG_INSTRUCTIONS,
  withRagContext,
  ragQuery,
  type RagRetrieval,
} from '@/lib/rag-context';
import {
  RagError,
  retrieveRagContext,
  withRagMetadata,
} from '@/lib/server/rag';
import type {
  ApiChatMessage,
  ChatOutputFormat,
  ChatRequest,
} from '@/lib/chat-types';
import {
  calculateMaxOutputTokens,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_TARGET_OUTPUT_TOKENS,
  DEFAULT_TEMPERATURE,
  isValidContextWindowTokens,
  isValidMaxOutputTokens,
  isValidModel,
  isValidTargetOutputTokensOrNull,
  isValidTemperature,
  MAX_TEMPERATURE,
  MAX_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
  MIN_TEMPERATURE,
} from '@/lib/chat-constraints';
import {
  buildSelectorSystemPrompt,
  isValidCustomSystemPrompt,
  MAX_CUSTOM_SYSTEM_PROMPT_LENGTH,
} from '@/lib/chat-prompts';
import { isVisionModel } from '@/lib/file-attachments';
import {
  buildLongTermMemorySystemPrompt,
  isLongTermMemoryFacts,
} from '@/lib/memory-layers';
import {
  buildUserProfileSystemPrompt,
  normalizeProfileText,
} from '@/lib/user-profile';
import {
  buildTaskStateSystemPrompt,
  buildTaskTransitionMessage,
  restoreTaskState,
} from '@/lib/task-state';
import {
  isStructuredOutputFormat,
  type StructuredOutputFormat,
  validateStructuredOutput,
} from '@/lib/structured-output';

import {
  DEEPSEEK_ENDPOINT,
  DEEPSEEK_MODEL,
  jsonError,
  isChatMessage,
  createNormalizedStream,
  eventStreamResponse,
  completedOutputResponse,
  mappedUpstreamError,
  type DeepSeekResponsePayload,
  extractOutputTokens,
  extractInputTokenUsage,
  extractOutputText,
} from '@/lib/server/deepseek';
import { contextWindowError } from '@/lib/server/context-window';
import { generateInvariantSafeOutput } from '@/lib/server/task-invariants';
import { HELP_PROMPT, parseHelpCommand } from '@/lib/help-command';
import { SUPPORT_PROMPT, parseSupportCommand } from '@/lib/support-command';
import { FILES_PROMPT, parseFilesCommand } from '@/lib/files-command';
import {
  connectAgentMcp,
  type McpAgentConnection,
} from '@/lib/server/mcp-agent';
import {
  generateWithMcpTools,
  type McpGenerationResult,
} from '@/lib/server/mcp-deepseek';

const MAX_FORMAT_RETRIES = 3;

async function withMcpConnection(
  connection: McpAgentConnection | null,
  generate: () => Promise<Response>,
): Promise<Response> {
  try {
    return await generate();
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch {
        // The answer remains valid if the transport fails while closing.
      }
    }
  }
}

function isChatOutputFormat(value: unknown): value is ChatOutputFormat {
  return (
    value === 'text' || value === 'json' || value === 'xml' || value === 'yaml'
  );
}

async function generateStructuredOutput({
  apiKey,
  contextWindowTokens,
  format,
  maxOutputTokens,
  mcpConnection,
  messages,
  model,
  signal,
  systemPrompt,
  temperature,
}: {
  apiKey: string;
  contextWindowTokens: number;
  format: StructuredOutputFormat;
  maxOutputTokens: number;
  mcpConnection: McpAgentConnection | null;
  messages: ApiChatMessage[];
  model: string;
  signal: AbortSignal;
  systemPrompt: string | null;
  temperature: number;
}): Promise<Response> {
  const textFormat =
    format === 'json'
      ? ({ type: 'json_object' } as const)
      : ({ type: 'text' } as const);

  for (let attempt = 0; attempt <= MAX_FORMAT_RETRIES; attempt += 1) {
    if (signal.aborted) return new Response(null, { status: 499 });

    const retryInstruction =
      attempt === 0
        ? ''
        : ` A previous attempt did not pass server-side ${format.toUpperCase()} validation. Regenerate the complete answer and strictly follow the required format.`;
    const requestMessages =
      systemPrompt === null && retryInstruction
        ? [
            ...messages,
            { role: 'user' as const, content: retryInstruction.trim() },
          ]
        : messages;
    const requestSystemPrompt =
      systemPrompt === null ? null : `${systemPrompt}${retryInstruction}`;
    const overflowResponse = contextWindowError({
      contextWindowTokens,
      messages: requestMessages,
      systemPrompt: requestSystemPrompt,
    });

    if (overflowResponse) return overflowResponse;

    let payload: DeepSeekResponsePayload | null = null;
    let mcpResult: McpGenerationResult | null = null;
    if (mcpConnection) {
      const result = await generateWithMcpTools({
        apiKey,
        connection: mcpConnection,
        contextWindowTokens,
        maxOutputTokens,
        messages: requestMessages,
        model,
        signal,
        systemPrompt: requestSystemPrompt,
        temperature,
        textFormat,
      });
      if (result instanceof Response) return result;
      payload = result.payload;
      mcpResult = result;
    } else {
      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetch(DEEPSEEK_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            // Format repair must not re-enable a disabled system prompt.
            // Only the current retry gets this user instruction; history is unchanged.
            input: requestMessages,
            max_output_tokens: maxOutputTokens,
            temperature,
            stream: false,
            reasoning: { effort: 'none' },
            text: { format: textFormat },
            ...(requestSystemPrompt === null
              ? {}
              : { instructions: requestSystemPrompt }),
          }),
          cache: 'no-store',
          signal,
        });
      } catch {
        if (signal.aborted) return new Response(null, { status: 499 });
        return jsonError(502, {
          code: 'deepseek_unreachable',
          message:
            'Не удалось связаться с DeepSeek. Проверьте подключение к интернету.',
        });
      }

      if (!upstreamResponse.ok) return mappedUpstreamError(upstreamResponse);
      try {
        payload = (await upstreamResponse.json()) as DeepSeekResponsePayload;
      } catch {
        // A malformed upstream body is treated as an invalid generated result.
      }
    }

    if (payload?.status === 'incomplete') {
      const reachedTokenLimit =
        payload.incomplete_details?.reason === 'max_output_tokens';

      return jsonError(502, {
        code: reachedTokenLimit ? 'max_output_tokens' : 'response_incomplete',
        message: reachedTokenLimit
          ? `Ответ DeepSeek достиг лимита в ${maxOutputTokens} токенов. Увеличьте целевую длину и повторите запрос.`
          : 'DeepSeek не смог завершить структурированный ответ. Попробуйте ещё раз.',
      });
    }

    const content = payload ? extractOutputText(payload) : null;

    if (payload && content && validateStructuredOutput(content, format)) {
      return completedOutputResponse(content, {
        outputTokens: extractOutputTokens(payload),
        ...extractInputTokenUsage(payload),
        ...(mcpResult
          ? {
              toolInputTokens: mcpResult.toolInputTokens,
              toolOutputTokens: mcpResult.toolOutputTokens,
              mcpTools: mcpResult.usedTools,
              weatherJobId: mcpConnection?.scheduledWeatherJobIds?.at(-1),
            }
          : {}),
      });
    }
  }

  return jsonError(502, {
    code: 'invalid_model_output',
    message: `DeepSeek не смог сформировать корректный ${format.toUpperCase()} после трёх повторных попыток.`,
  });
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return jsonError(403, {
      code: 'cross_origin',
      message: 'Запрос с другого сайта запрещён.',
    });
  let body: ChatRequest;

  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return jsonError(400, {
      code: 'invalid_json',
      message: 'Тело запроса должно быть корректным JSON.',
    });
  }

  if (
    !body ||
    typeof body !== 'object' ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    body.messages.length > 100 ||
    !body.messages.every(isChatMessage) ||
    body.messages.at(-1)?.role !== 'user'
  ) {
    return jsonError(400, {
      code: 'invalid_messages',
      message: 'Передана некорректная история диалога.',
    });
  }

  // Slash commands rewrite the last message and pick a prompt. /help and
  // /support also search the documentation (RAG); /files only needs the file
  // tools. All of them use the plain (non-grounded) generation path.
  const lastMessage = body.messages.at(-1)!;
  const commandText =
    typeof lastMessage.content === 'string' ? lastMessage.content : null;
  const command = commandText
    ? ([
        { question: parseHelpCommand(commandText), prompt: HELP_PROMPT, rag: true },
        { question: parseSupportCommand(commandText), prompt: SUPPORT_PROMPT, rag: true },
        { question: parseFilesCommand(commandText), prompt: FILES_PROMPT, rag: false },
      ].find((item) => item.question !== null) ?? null)
    : null;
  const commandQuestion = command?.question ?? null;
  const commandPrompt = command?.prompt ?? null;
  if (command && commandQuestion !== null) {
    const localModel =
      typeof body.model === 'string' && isLocalModel(body.model);
    if (!command.rag && localModel) {
      return jsonError(400, {
        code: 'local_tools_unsupported',
        message:
          'Команда /files работает с MCP-инструментами, которых нет у локальных агентов Ollama.',
      });
    }
    body.messages = [
      ...body.messages.slice(0, -1),
      { ...lastMessage, content: commandQuestion },
    ];
    body.useRag = command.rag;
    // Local Ollama agents have no MCP tools: /help and /support use RAG only.
    body.useMcpTools = !localModel;
    delete body.ragGrounding;
    delete body.ragDialogue;
    delete body.ragSearch;
    delete body.ragBuildId;
  }

  if (
    (body.ragDialogue !== undefined &&
      (typeof body.ragDialogue !== 'boolean' ||
        (body.ragDialogue && body.ragGrounding !== true))) ||
    (body.ragGrounding !== undefined &&
      (typeof body.ragGrounding !== 'boolean' || body.useRag !== true)) ||
    (body.ragSearch !== undefined &&
      (body.useRag !== true || !isRagSearchOptions(body.ragSearch))) ||
    (body.useRag !== undefined && typeof body.useRag !== 'boolean') ||
    (body.ragBuildId !== undefined &&
      (body.useRag !== true ||
        typeof body.ragBuildId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,100}$/u.test(body.ragBuildId)))
  ) {
    return jsonError(400, {
      code: 'invalid_rag_mode',
      message: 'Режим RAG или версия индекса указаны некорректно.',
    });
  }

  const outputFormat = body.format ?? 'text';
  const grounding = body.ragGrounding === true;
  const generationFormat = grounding ? 'json' : outputFormat;

  if (!isChatOutputFormat(outputFormat)) {
    return jsonError(400, {
      code: 'invalid_format',
      message: 'Выбран неподдерживаемый формат ответа.',
    });
  }

  // `null` explicitly disables the target length (and, with it, the
  // derived max-output cap below) — only `undefined` falls back to the
  // default target.
  const targetOutputTokens =
    body.targetOutputTokens === undefined
      ? DEFAULT_TARGET_OUTPUT_TOKENS
      : body.targetOutputTokens;

  if (!isValidTargetOutputTokensOrNull(targetOutputTokens)) {
    return jsonError(400, {
      code: 'invalid_target_output_tokens',
      message: 'Целевая длина ответа указана некорректно.',
    });
  }

  const maxOutputTokens =
    body.maxOutputTokens === undefined
      ? calculateMaxOutputTokens(targetOutputTokens)
      : body.maxOutputTokens;

  if (!isValidMaxOutputTokens(maxOutputTokens)) {
    return jsonError(400, {
      code: 'invalid_max_output_tokens',
      message: 'Технический лимит длины ответа указан некорректно.',
    });
  }

  const contextWindowTokens =
    body.contextWindowTokens === undefined
      ? DEFAULT_CONTEXT_WINDOW_TOKENS
      : body.contextWindowTokens;

  if (!isValidContextWindowTokens(contextWindowTokens)) {
    return jsonError(400, {
      code: 'invalid_context_window_tokens',
      message: `Укажите лимит контекста от ${MIN_CONTEXT_WINDOW_TOKENS} до ${MAX_CONTEXT_WINDOW_TOKENS} токенов.`,
    });
  }

  const temperature =
    body.temperature === undefined ? DEFAULT_TEMPERATURE : body.temperature;

  if (!isValidTemperature(temperature)) {
    return jsonError(400, {
      code: 'invalid_temperature',
      message: `Укажите температуру от ${MIN_TEMPERATURE} до ${MAX_TEMPERATURE}.`,
    });
  }

  const model = body.model === undefined ? DEEPSEEK_MODEL : body.model;

  if (!isValidModel(model)) {
    return jsonError(400, {
      code: 'invalid_model',
      message: 'Некорректный идентификатор модели.',
    });
  }

  const local = isLocalModel(model);
  if (
    body.localRagProfile !== undefined &&
    !isLocalRagProfile(body.localRagProfile)
  )
    return jsonError(400, {
      code: 'invalid_local_profile',
      message: 'Неизвестный профиль локальной модели.',
    });
  const compactRag = local && grounding && body.localRagProfile === 'compact';
  if (local) {
    try {
      ollamaEndpoint('/api/chat');
      if (body.useRag) {
        const url = new URL(
          process.env.RAG_SERVICE_URL ?? 'http://127.0.0.1:18803/rag',
        );
        if (
          url.protocol !== 'http:' ||
          !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
          url.username ||
          url.password
        )
          throw new Error();
      }
    } catch {
      return jsonError(400, {
        code: 'local_only',
        message:
          'Для локального агента Ollama и RAG должны работать на loopback.',
      });
    }
    if (body.taskState || body.useMcpTools)
      return jsonError(400, {
        code: 'local_tools_unsupported',
        message:
          'Локальный агент поддерживает чат, RAG и память; MCP и управление задачами пока недоступны.',
      });
  }
  const hasImages = body.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'input_image'),
  );

  if (hasImages && !isVisionModel(model)) {
    return jsonError(400, {
      code: 'vision_model_required',
      message: 'Для работы с изображениями выберите модель DeepSeek Flash.',
    });
  }

  if (
    (body.useSystemPrompt !== undefined &&
      typeof body.useSystemPrompt !== 'boolean') ||
    (body.useSelectorSystemPrompt !== undefined &&
      typeof body.useSelectorSystemPrompt !== 'boolean') ||
    (body.useMcpTools !== undefined && typeof body.useMcpTools !== 'boolean')
  ) {
    return jsonError(400, {
      code: 'invalid_system_prompt_mode',
      message: 'Режим системного промпта указан некорректно.',
    });
  }

  if (
    body.longTermMemory !== undefined &&
    !isLongTermMemoryFacts(body.longTermMemory)
  ) {
    return jsonError(400, {
      code: 'invalid_long_term_memory',
      message: 'Долговременная память передана некорректно.',
    });
  }

  const taskState =
    body.taskState === undefined ? null : restoreTaskState(body.taskState);
  if (body.taskState !== undefined && !taskState) {
    return jsonError(400, {
      code: 'invalid_task_state',
      message: 'Состояние задачи передано некорректно.',
    });
  }
  const transitionMessage = taskState
    ? buildTaskTransitionMessage(taskState)
    : null;
  let requestMessages = transitionMessage
    ? [...body.messages.slice(0, -1), transitionMessage, body.messages.at(-1)!]
    : body.messages;

  const profile =
    body.profile === undefined ? '' : normalizeProfileText(body.profile);
  if (body.profile !== undefined && profile === null) {
    return jsonError(400, {
      code: 'invalid_user_profile',
      message: 'Профиль пользователя передан некорректно.',
    });
  }

  let configuredPrompt: string | null;

  if (body.useSystemPrompt === false) {
    configuredPrompt = null;
  } else if (body.useSelectorSystemPrompt === false) {
    if (!isValidCustomSystemPrompt(body.customSystemPrompt)) {
      return jsonError(400, {
        code: 'invalid_custom_system_prompt',
        message: `Введите системный промпт от 1 до ${MAX_CUSTOM_SYSTEM_PROMPT_LENGTH} символов.`,
      });
    }
    configuredPrompt = body.customSystemPrompt;
  } else {
    configuredPrompt = buildSelectorSystemPrompt(
      outputFormat,
      targetOutputTokens,
    );
  }
  const longTermPrompt = buildLongTermMemorySystemPrompt(
    body.longTermMemory ?? [],
  );
  const profilePrompt = profile ? buildUserProfileSystemPrompt(profile) : null;
  const taskPrompt = taskState ? buildTaskStateSystemPrompt(taskState) : null;
  let systemPrompt =
    [
      configuredPrompt,
      profilePrompt,
      longTermPrompt,
      taskPrompt,
      commandPrompt,
    ]
      .filter(Boolean)
      .join('\n\n') || null;

  const overflowResponse = contextWindowError({
    contextWindowTokens,
    messages: requestMessages,
    systemPrompt,
  });

  if (overflowResponse) return overflowResponse;

  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

  if (!local && !apiKey && !grounding) {
    return jsonError(500, {
      code: 'configuration_error',
      message: 'DEEPSEEK_API_KEY не настроен. Добавьте токен в .env.local.',
    });
  }

  let retrieval: RagRetrieval | null = null;
  if (body.useRag) {
    try {
      let searchMessages = body.messages;
      if (body.ragDialogue) {
        const plan = await prepareDialogueQuestion(
          body.messages,
          request.signal,
        );
        if (plan.intent === 'memory') {
          return completedOutputResponse(
            renderDialogueContext(body.messages, outputFormat),
            { outputTokens: 0 },
          );
        }
        searchMessages = [{ role: 'user', content: plan.question }];
        // Retain user requirements in history; generation and coverage answer
        // the same standalone documentation question that retrieval searched.
        requestMessages = [
          ...requestMessages,
          { role: 'user', content: plan.question },
        ];
      }
      retrieval = await retrieveRagContext(
        searchMessages,
        request.signal,
        body.ragBuildId,
        body.ragSearch ??
          (grounding
            ? {
                rewrite: false,
                filter: true,
                topKBefore: 5,
                topKAfter: 5,
                minSimilarity: 0.45,
              }
            : undefined),
        grounding,
      );
      if (body.ragDialogue) retrieval.original_query = ragQuery(body.messages);
      requestMessages = grounding
        ? [
            ...requestMessages.slice(0, -1),
            {
              role: 'user',
              content: `RAG_CONTEXT_JSON\n${JSON.stringify(localRagContext(retrieval, compactRag ? 'compact' : 'baseline'))}`,
            },
            requestMessages.at(-1)!,
          ]
        : withRagContext(requestMessages, retrieval);
      systemPrompt = [
        systemPrompt,
        grounding
          ? compactRag
            ? localRagPrompt('compact')
            : GROUNDING_PROMPT
          : RAG_INSTRUCTIONS,
        ...(retrieval.sources.length === 0 ? [EMPTY_RAG_INSTRUCTIONS] : []),
      ]
        .filter(Boolean)
        .join('\n\n');
    } catch (error) {
      if (request.signal.aborted) return new Response(null, { status: 499 });
      const failure =
        error instanceof RagError
          ? error
          : new RagError('rag_failed', 'Не удалось подготовить контекст RAG.');
      return jsonError(failure.status, {
        code: failure.code,
        message: failure.message,
      });
    }
    const ragOverflow = contextWindowError({
      contextWindowTokens,
      messages: requestMessages,
      systemPrompt,
    });
    if (ragOverflow) return ragOverflow;
  }

  if (
    retrieval &&
    grounding &&
    !retrieval.sources.some((source) =>
      passesGroundingThreshold(source, retrieval.processing?.options),
    )
  ) {
    return withRagMetadata(
      unknownGroundedResponse('weak_context', outputFormat),
      retrieval,
    );
  }

  if (!local && !apiKey)
    return jsonError(500, {
      code: 'configuration_error',
      message: 'DEEPSEEK_API_KEY не настроен. Добавьте токен в .env.local.',
    });

  const generate = async (): Promise<Response> => {
    if (local) {
      const settings = LOCAL_RAG_PROFILES.compact;
      const limit = Math.min(
        body.contextWindowTokens === undefined && compactRag
          ? settings.contextTokens
          : contextWindowTokens,
        LOCAL_CONTEXT_TOKENS,
      );
      const outputLimit =
        body.maxOutputTokens !== undefined
          ? Math.min(8192, maxOutputTokens)
          : compactRag
            ? Math.min(maxOutputTokens, settings.maxOutputTokens)
            : Math.min(
                8192,
                grounding ? Math.max(4096, maxOutputTokens) : maxOutputTokens,
              );
      const overflow = contextWindowError({
        contextWindowTokens: limit - outputLimit,
        messages: requestMessages,
        systemPrompt,
      });
      if (overflow) return overflow;
      const localMessages = requestMessages.map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content
                .filter((p) => p.type === 'input_text')
                .map((p) => p.text)
                .join('\n'),
      }));
      const result = await generateLocalChat({
        model: localModelName(model),
        messages: [
          ...(systemPrompt
            ? [{ role: 'system' as const, content: systemPrompt }]
            : []),
          ...localMessages,
        ],
        signal: request.signal,
        format: compactRag ? localRagFormat('compact') : generationFormat,
        temperature:
          compactRag && body.temperature === undefined
            ? settings.temperature
            : temperature,
        contextTokens: limit,
        maxOutputTokens: outputLimit,
      });
      if (!result.ok) {
        const error = (await result.json()) as { error: string };
        return jsonError(result.status, {
          code: 'local_unavailable',
          message: error.error,
        });
      }
      return result;
    }
    const mcpConnection =
      body.useMcpTools && !grounding
        ? await connectAgentMcp(request.signal)
        : null;
    if (request.signal.aborted) return new Response(null, { status: 499 });

    if (taskState && systemPrompt) {
      return withMcpConnection(mcpConnection, () =>
        generateInvariantSafeOutput({
          apiKey: apiKey!,
          contextWindowTokens,
          format: generationFormat,
          maxOutputTokens,
          mcpConnection,
          messages: requestMessages,
          model,
          signal: request.signal,
          state: taskState,
          systemPrompt,
          temperature,
        }),
      );
    }

    if (isStructuredOutputFormat(generationFormat)) {
      return withMcpConnection(mcpConnection, () =>
        generateStructuredOutput({
          apiKey: apiKey!,
          contextWindowTokens,
          format: generationFormat,
          maxOutputTokens,
          mcpConnection,
          messages: requestMessages,
          model,
          signal: request.signal,
          systemPrompt,
          temperature,
        }),
      );
    }

    if (mcpConnection) {
      return withMcpConnection(mcpConnection, async () => {
        const result = await generateWithMcpTools({
          apiKey: apiKey!,
          connection: mcpConnection,
          contextWindowTokens,
          maxOutputTokens,
          messages: requestMessages,
          model,
          signal: request.signal,
          systemPrompt,
          temperature,
          textFormat: { type: 'text' },
        });
        if (result instanceof Response) return result;
        const content = extractOutputText(result.payload);
        if (!content) {
          return jsonError(502, {
            code: 'invalid_model_output',
            message:
              'DeepSeek не смог сформировать ответ после обращения к MCP.',
          });
        }
        return completedOutputResponse(content, {
          outputTokens: extractOutputTokens(result.payload),
          ...extractInputTokenUsage(result.payload),
          toolInputTokens: result.toolInputTokens,
          toolOutputTokens: result.toolOutputTokens,
          mcpTools: result.usedTools,
          weatherJobId: mcpConnection.scheduledWeatherJobIds?.at(-1),
        });
      });
    }

    let upstreamResponse: Response;

    try {
      upstreamResponse = await fetch(DEEPSEEK_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: requestMessages,
          max_output_tokens: maxOutputTokens,
          temperature,
          stream: true,
          reasoning: { effort: 'none' },
          text: { format: { type: 'text' } },
          ...(systemPrompt ? { instructions: systemPrompt } : {}),
        }),
        cache: 'no-store',
        signal: request.signal,
      });
    } catch {
      if (request.signal.aborted) {
        return new Response(null, { status: 499 });
      }

      return jsonError(502, {
        code: 'deepseek_unreachable',
        message:
          'Не удалось связаться с DeepSeek. Проверьте подключение к интернету.',
      });
    }

    if (!upstreamResponse.ok) return mappedUpstreamError(upstreamResponse);

    if (!upstreamResponse.body) {
      return jsonError(502, {
        code: 'empty_upstream_response',
        message: 'DeepSeek вернул пустой ответ. Попробуйте ещё раз.',
      });
    }

    return eventStreamResponse(
      createNormalizedStream(
        upstreamResponse.body,
        request.signal,
        body.maxOutputTokens === undefined
          ? {}
          : {
              tokenLimitMessage: `Ответ DeepSeek достиг технического лимита вывода ${maxOutputTokens} токенов. Сократите требуемый ответ и повторите запрос.`,
            },
      ),
    );
  };
  let response = await generate();
  if (retrieval && grounding) {
    response = await enforceGroundedResponse(
      response,
      retrieval,
      outputFormat,
      request.signal,
      async (feedback) => {
        // The repair feedback carries the complete updated catalog. Remove the
        // initial injected catalog rather than spending the context budget twice.
        const initialContext = requestMessages.at(-2);
        if (
          typeof initialContext?.content === 'string' &&
          initialContext.content.startsWith('RAG_CONTEXT_JSON\n')
        ) {
          requestMessages = [
            ...requestMessages.slice(0, -2),
            requestMessages.at(-1)!,
          ];
        }
        requestMessages = [
          ...requestMessages,
          { role: 'user', content: feedback },
        ];
        const overflow = contextWindowError({
          contextWindowTokens,
          messages: requestMessages,
          systemPrompt,
        });
        return overflow ?? generate();
      },
    );
  }
  return retrieval ? withRagMetadata(response, retrieval) : response;
}
