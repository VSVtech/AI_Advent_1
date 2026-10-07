// Persist a provider-qualified model id to avoid collisions and accidental cloud fallback.
export const LOCAL_MODEL_PREFIX = 'ollama:';
export function isLocalModel(model: string) {
  return model.startsWith(LOCAL_MODEL_PREFIX);
}
export function localModelName(model: string) {
  return model.slice(LOCAL_MODEL_PREFIX.length);
}
export const LOCAL_CONTEXT_TOKENS = 32768;
