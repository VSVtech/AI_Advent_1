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

# The MCP server stays bound to loopback on the capsule. A local SSH forward
# gives the app access without exposing the unauthenticated MCP port publicly.
mcp_ssh_key="${MCP_SSH_KEY:-${HOME}/.ssh/ai-vps-key}"
mcp_ssh_target="${MCP_SSH_TARGET:-user@91.188.213.204}"
mcp_tunnel_pid=''

# The forward drops when the Mac sleeps or the network changes, so it is
# re-established until the app exits.
keep_mcp_tunnel() {
  local app_pid=$1
  tunnel_ssh_pid=''
  trap 'if [[ -n "$tunnel_ssh_pid" ]]; then kill "$tunnel_ssh_pid" 2>/dev/null; fi; exit 0' TERM
  while kill -0 "$app_pid" 2>/dev/null; do
    ssh \
      -i "$mcp_ssh_key" \
      -o BatchMode=yes \
      -o ConnectTimeout=5 \
      -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=15 \
      -o ServerAliveCountMax=2 \
      -N \
      -L 127.0.0.1:18765:127.0.0.1:8765 \
      "$mcp_ssh_target" &
    tunnel_ssh_pid=$!
    wait "$tunnel_ssh_pid" || true
    tunnel_ssh_pid=''
    sleep 5
  done
}

if [[ -f "$mcp_ssh_key" ]] && command -v ssh >/dev/null 2>&1; then
  keep_mcp_tunnel "$$" &
  mcp_tunnel_pid=$!
fi

# Local MCP servers «Поездки» and «Заметки»: the agent routes tool calls
# between them and the capsule.
local_mcp_pids=''
for mcp_server in travel notes; do
  node "scripts/mcp-servers/${mcp_server}.mjs" &
  local_mcp_pids="$local_mcp_pids $!"
done

node scripts/rag/server.mjs &
local_mcp_pids="$local_mcp_pids $!"
if command -v ollama >/dev/null 2>&1 || [[ -x .local-data/rag/runtime/ollama ]]; then
  node scripts/rag/ollama.mjs &
  local_mcp_pids="$local_mcp_pids $!"
fi

cleanup() {
  for pid in $local_mcp_pids; do
    kill "$pid" 2>/dev/null || true
  done
  if [[ -n "$mcp_tunnel_pid" ]]; then
    kill "$mcp_tunnel_pid" 2>/dev/null || true
    wait "$mcp_tunnel_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

pnpm dev "$@"
