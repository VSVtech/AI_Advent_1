import {
  GROUNDING_CONFIG_PATH,
  LARGE_GROUNDING_MODEL,
  validateGroundingConfig,
} from './grounding-config.mjs';
import { LocalGroundingVerifier } from './grounding-model.mjs';
import { atomicWrite } from './storage.mjs';
const model =
  process.argv.find((a) => a.startsWith('--model='))?.slice(8) ??
  LARGE_GROUNDING_MODEL;
const thinkArg =
  process.argv.find((a) => a.startsWith('--think='))?.slice(8) ?? 'false';
if (!['true', 'false'].includes(thinkArg))
  throw new Error('--think=true или --think=false');
const config = validateGroundingConfig({ model, think: thinkArg === 'true' });
const identity = await new LocalGroundingVerifier(undefined, config).describe(
  AbortSignal.timeout(5000),
);
await atomicWrite(
  GROUNDING_CONFIG_PATH,
  JSON.stringify(config, null, 2) + '\n',
);
console.log(
  `Проверяющий: ${identity.model}; thinking: ${identity.think}. Перезапустите pnpm rag:server.`,
);
