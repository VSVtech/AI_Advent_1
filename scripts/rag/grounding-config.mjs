import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.mjs';
import { EVIDENCE_MODEL } from './evidence.mjs';
import { LocalGroundingVerifier } from './grounding-model.mjs';

export const LARGE_GROUNDING_MODEL = 'qwen3.5:27b-q4_K_M';
export const GROUNDING_CONFIG_PATH = join(DATA_DIR, 'grounding-config.json');
export function validateGroundingConfig(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    ![EVIDENCE_MODEL, LARGE_GROUNDING_MODEL].includes(value.model) ||
    typeof value.think !== 'boolean' ||
    (value.model === EVIDENCE_MODEL && value.think)
  )
    throw new Error(
      'Настройки проверяющего: допустимы локальные Qwen2.5 7B или Qwen3.5 27B и boolean think.',
    );
  return { model: value.model, think: value.think };
}
export function readGroundingConfig(path = GROUNDING_CONFIG_PATH) {
  try {
    return validateGroundingConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return { model: EVIDENCE_MODEL, think: false };
    throw error;
  }
}
export function createConfiguredGroundingVerifier() {
  return new LocalGroundingVerifier(undefined, readGroundingConfig());
}
