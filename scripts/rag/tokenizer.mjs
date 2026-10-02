import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import { TOKENIZER_REVISION } from './config.mjs';

export async function loadTokenizer(dataDir) {
  try {
    const directory = join(dataDir, 'tokenizer', TOKENIZER_REVISION);
    const [definition, config] = await Promise.all(
      ['tokenizer.json', 'tokenizer_config.json'].map(async (name) =>
        JSON.parse(await readFile(join(directory, name), 'utf8')),
      ),
    );
    const tokenizer = new Tokenizer(definition, config);
    return {
      encode: (text) =>
        tokenizer.encode(text, { add_special_tokens: false }).ids,
      decode: (ids) =>
        tokenizer.decode(ids, {
          skip_special_tokens: false,
          clean_up_tokenization_spaces: false,
        }),
    };
  } catch {
    throw new Error('Токенизатор не подготовлен. Выполните pnpm rag:setup.');
  }
}
