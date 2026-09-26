import {
  estimateContextTokenCount,
  estimateTokenCount,
} from '@/lib/chat-constraints';
import { buildSkillsPrompt } from '@/lib/agent-skills';
import type { ApiChatMessage } from '@/lib/chat-types';
import {
  DEEPSEEK_ENDPOINT,
  extractInputTokenUsage,
  extractOutputTokens,
  jsonError,
  mappedUpstreamError,
  type DeepSeekResponsePayload,
} from '@/lib/server/deepseek';
import type { McpAgentConnection } from '@/lib/server/mcp-agent';

const MAX_TOOL_ROUNDS = 3;
const MAX_TOOL_CALLS = 8;
const MAX_ARGUMENTS_LENGTH = 16_000;

type FunctionCall = {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
};

type FunctionCallOutput = {
  type: 'function_call_output';
  call_id: string;
  output: string;
};

type DeepSeekInputItem = ApiChatMessage | FunctionCall | FunctionCallOutput;

export type McpGenerationResult = {
  payload: DeepSeekResponsePayload;
  usedTools: string[];
  toolInputTokens: number | null;
  toolOutputTokens: number | null;
};

function parseCalls(payload: DeepSeekResponsePayload): FunctionCall[] | null {
  const items =
    payload.output?.filter((item) => item.type === 'function_call') ?? [];
  const calls: FunctionCall[] = [];
  for (const item of items) {
    if (
      typeof item.call_id !== 'string' ||
      !item.call_id.trim() ||
      typeof item.name !== 'string' ||
      typeof item.arguments !== 'string' ||
      item.arguments.length > MAX_ARGUMENTS_LENGTH
    ) {
      return null;
    }
    calls.push({
      type: 'function_call',
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
    });
  }
  return calls;
}

function parseArguments(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function generateWithMcpTools({
  apiKey,
  connection,
  contextWindowTokens,
  maxOutputTokens,
  messages,
  model,
  signal,
  systemPrompt,
  temperature,
  textFormat,
}: {
  apiKey: string;
  connection: McpAgentConnection;
  contextWindowTokens: number;
  maxOutputTokens: number;
  messages: ApiChatMessage[];
  model: string;
  signal: AbortSignal;
  systemPrompt: string | null;
  temperature: number;
  textFormat: { type: 'text' } | { type: 'json_object' };
}): Promise<McpGenerationResult | Response> {
  const input: DeepSeekInputItem[] = [...messages];
  // Skills travel with the tools they chain, like the tool descriptions.
  const instructions =
    [systemPrompt, buildSkillsPrompt(connection.tools.map((tool) => tool.name))]
      .filter(Boolean)
      .join('\n\n') || null;
  const seenCallIds = new Set<string>();
  const usedTools: string[] = [];
  let toolInputTokens = 0;
  let toolOutputTokens = 0;
  let hasInputUsage = false;
  let hasOutputUsage = false;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    if (signal.aborted) return new Response(null, { status: 499 });
    const estimatedTokens =
      estimateContextTokenCount(messages, instructions) +
      estimateTokenCount(JSON.stringify(connection.tools)) +
      estimateTokenCount(JSON.stringify(input.slice(messages.length)));
    if (estimatedTokens > contextWindowTokens) {
      return jsonError(413, {
        code: 'context_window_exceeded',
        message: `Контекст с описаниями и результатами MCP-инструментов занимает примерно ${estimatedTokens} токенов при лимите агента ${contextWindowTokens}. Увеличьте лимит или сократите контекст.`,
      });
    }

    let response: Response;
    try {
      response = await fetch(DEEPSEEK_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input,
          max_output_tokens: maxOutputTokens,
          temperature,
          stream: false,
          reasoning: { effort: 'none' },
          text: { format: textFormat },
          tools: connection.tools,
          tool_choice: round === MAX_TOOL_ROUNDS ? 'none' : 'auto',
          ...(instructions ? { instructions } : {}),
        }),
        cache: 'no-store',
        signal,
      });
    } catch {
      return signal.aborted
        ? new Response(null, { status: 499 })
        : jsonError(502, {
            code: 'deepseek_unreachable',
            message:
              'Не удалось связаться с DeepSeek. Проверьте подключение к интернету.',
          });
    }
    if (!response.ok) return mappedUpstreamError(response);

    let payload: DeepSeekResponsePayload;
    try {
      payload = (await response.json()) as DeepSeekResponsePayload;
    } catch {
      return jsonError(502, {
        code: 'invalid_model_output',
        message: 'DeepSeek вернул некорректный ответ при работе с MCP.',
      });
    }
    if (payload.status === 'incomplete') {
      return jsonError(502, {
        code: 'response_incomplete',
        message:
          'DeepSeek не смог завершить вызов MCP. Увеличьте длину ответа или повторите запрос.',
      });
    }
    if (payload.status !== 'completed' || !Array.isArray(payload.output)) {
      return jsonError(502, {
        code: 'invalid_model_output',
        message: 'DeepSeek не завершил ответ при работе с MCP.',
      });
    }

    const calls = parseCalls(payload);
    if (!calls) {
      return jsonError(502, {
        code: 'invalid_tool_call',
        message: 'DeepSeek вернул некорректный вызов инструмента.',
      });
    }
    if (calls.length === 0) {
      return {
        payload,
        usedTools,
        toolInputTokens: hasInputUsage ? toolInputTokens : null,
        toolOutputTokens: hasOutputUsage ? toolOutputTokens : null,
      };
    }
    if (
      round === MAX_TOOL_ROUNDS ||
      calls.length + seenCallIds.size > MAX_TOOL_CALLS ||
      calls.some(
        (call) =>
          seenCallIds.has(call.call_id) ||
          !connection.tools.some((tool) => tool.name === call.name) ||
          parseArguments(call.arguments) === null,
      ) ||
      new Set(calls.map((call) => call.call_id)).size !== calls.length
    ) {
      return jsonError(502, {
        code: 'invalid_tool_call',
        message:
          'DeepSeek запросил недопустимый или слишком большой набор MCP-вызовов.',
      });
    }

    const { inputTokens } = extractInputTokenUsage(payload);
    const outputTokens = extractOutputTokens(payload);
    if (inputTokens !== null) {
      toolInputTokens += inputTokens;
      hasInputUsage = true;
    }
    if (outputTokens !== null) {
      toolOutputTokens += outputTokens;
      hasOutputUsage = true;
    }

    for (const item of payload.output) {
      if (item.type === 'message') {
        const content = item.content
          ?.filter(
            (part) =>
              part.type === 'output_text' && typeof part.text === 'string',
          )
          .map((part) => part.text as string)
          .join('');
        if (content) input.push({ role: 'assistant', content });
      } else if (item.type === 'function_call') {
        const call = calls.find(
          (candidate) => candidate.call_id === item.call_id,
        );
        if (call) input.push(call);
      }
    }
    for (const call of calls) {
      seenCallIds.add(call.call_id);
      usedTools.push(call.name);
      let output: string;
      try {
        output = await connection.callTool(
          call.name,
          parseArguments(call.arguments)!,
          signal,
        );
      } catch {
        return signal.aborted
          ? new Response(null, { status: 499 })
          : jsonError(502, {
              code: 'mcp_tool_error',
              message:
                'Не удалось выполнить MCP-инструмент. Попробуйте ещё раз.',
            });
      }
      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output,
      });
    }
  }

  return jsonError(502, {
    code: 'mcp_tool_limit',
    message: 'Агент превысил лимит вызовов MCP-инструментов за один запрос.',
  });
}
