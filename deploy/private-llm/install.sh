#!/usr/bin/env bash
# Run on the VPS with sudo. Archive is downloaded and verified before extraction.
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run with sudo.' >&2; exit 1; fi
repo_dir=${1:?Usage: install.sh SOURCE_DIRECTORY NODE_BINARY OLLAMA_ARCHIVE}
node_binary=${2:?Specify existing Node.js 22.13+ binary}
archive=${3:?Specify Ollama v0.40.3 linux-amd64 archive}
if [[ $(uname -m) != x86_64 ]]; then echo 'This installer is for Linux x86_64.' >&2; exit 1; fi
"$node_binary" -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22||(major===22&&minor<13))process.exit(1)'
echo "ce6f8b671a699bf1ebafb28d60dbbabf4f37b30b499145fa308a8ba72de021d6  $archive" | sha256sum -c -
id ai-llm >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/ai-private-llm --shell /usr/sbin/nologin ai-llm
install -d -o ai-llm -g ai-llm -m 700 /var/lib/ai-private-llm /var/lib/ai-private-llm/models
install -d -m 755 /opt/ai-private-llm/app/public /opt/ai-private-llm/runtime
install -d -o root -g ai-llm -m 750 /etc/ai-private-llm
tar --zstd -xf "$archive" -C /opt/ai-private-llm/runtime
install -m 755 "$node_binary" /opt/ai-private-llm/runtime/bin/node
install -m 644 "$repo_dir"/scripts/private-llm/{server,config,queue}.mjs /opt/ai-private-llm/app/
install -m 644 "$repo_dir"/scripts/private-llm/public/* /opt/ai-private-llm/app/public/
if [[ ! -f /etc/ai-private-llm/token ]]; then
  /opt/ai-private-llm/runtime/bin/node -e 'require("fs").writeFileSync("/etc/ai-private-llm/token",require("crypto").randomBytes(32).toString("hex")+"\n",{mode:0o640,flag:"wx"})'
fi
chown root:ai-llm /etc/ai-private-llm/token
chmod 640 /etc/ai-private-llm/token
if [[ ! -f /etc/ai-private-llm/service.env ]]; then
  install -o root -g ai-llm -m 640 "$repo_dir/deploy/private-llm/service.env.example" /etc/ai-private-llm/service.env
fi
install -m 644 "$repo_dir"/deploy/private-llm/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ai-private-ollama
for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:11435/api/version >/dev/null; then break; fi
  sleep 1
done
# Download only model weights. Inference never uses an external provider.
runuser -u ai-llm -- env OLLAMA_HOST=127.0.0.1:11435 /opt/ai-private-llm/runtime/bin/ollama pull qwen2.5:0.5b
systemctl enable ai-private-llm
systemctl restart ai-private-llm
echo 'Installed. API: loopback port 18804; access via SSH tunnel. Key: /etc/ai-private-llm/token (not printed).'
