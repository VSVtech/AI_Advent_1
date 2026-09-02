import { calculateTargetOutputRange } from '@/lib/chat-constraints';
import type { ChatOutputFormat } from '@/lib/chat-types';

export const MAX_CUSTOM_SYSTEM_PROMPT_LENGTH = 20_000;

export function isValidCustomSystemPrompt(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_CUSTOM_SYSTEM_PROMPT_LENGTH
  );
}

function targetLengthInstruction(targetOutputTokens: number): string {
  const targetRange = calculateTargetOutputRange(targetOutputTokens);
  const approximateWordTarget = Math.max(
    20,
    Math.floor(targetOutputTokens * 0.6),
  );

  return [
    `The complete answer must contain between ${targetRange.min} and ${targetRange.max} output tokens.`,
    `For prose, use approximately ${approximateWordTarget} words as an additional planning guide.`,
    'Treat the token range as a required target, not merely an upper bound or a suggestion.',
    'The separate API token limit is only an emergency buffer for completing the answer and closing structured data; do not use that allowance as the target length.',
    'Plan the response length before writing and finish inside the target range.',
    'Develop relevant details, examples, edge cases, and explanations without repetition or filler.',
    'Do not cut off a sentence, list, code block, JSON object, XML document, or YAML document to meet the target.',
  ].join(' ');
}

const FORMAT_INSTRUCTIONS: Record<Exclude<ChatOutputFormat, 'text'>, string> = {
  json: [
    'Return only valid json.',
    'Use a JSON object with a structure appropriate to the user request.',
    'Do not wrap the result in Markdown or add explanatory text.',
  ].join(' '),
  xml: [
    'Return only well-formed XML with exactly one <response> root element.',
    'Do not put answer text directly inside <response>.',
    'Represent every top-level logical section as its own direct child element with a descriptive tag name.',
    'For example, an answer containing a topic and an explanation must use separate <topic> and <explanation> elements.',
    'Never combine labeled sections such as "Topic:" and "Explanation:" inside one text node.',
    'Do not wrap the result in Markdown or add explanatory text.',
  ].join(' '),
  yaml: [
    'Return only valid YAML whose root is a mapping or sequence.',
    'Do not return a scalar string, number, boolean, or null as the root value.',
    'Use a structure appropriate to the user request.',
    'Place semantic fields directly at the document root.',
    'Do not add a generic wrapper key named YAML, response, data, result, or output.',
    'Do not wrap the result in Markdown or add explanatory text.',
  ].join(' '),
};

// Shared by the editor preview and the server so both show/use the same prompt.
export function buildSelectorSystemPrompt(
  format: ChatOutputFormat,
  targetOutputTokens: number,
): string {
  const lengthInstruction = targetLengthInstruction(targetOutputTokens);

  return format === 'text'
    ? lengthInstruction
    : `${FORMAT_INSTRUCTIONS[format]} ${lengthInstruction}`;
}
