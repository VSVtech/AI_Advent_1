#!/usr/bin/env bash

set -Eeuo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

if ! command -v pnpm >/dev/null 2>&1; then
  printf 'Ошибка: pnpm не найден. Установите pnpm и повторите запуск.\n' >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  printf 'Ошибка: зависимости не установлены. Выполните pnpm install.\n' >&2
  exit 1
fi

if [[ -z "${DEEPSEEK_API_KEY:-}" && ! -f .env.local ]]; then
  printf 'Предупреждение: DEEPSEEK_API_KEY не настроен; чат не сможет обращаться к DeepSeek.\n' >&2
fi

exec pnpm dev "$@"
