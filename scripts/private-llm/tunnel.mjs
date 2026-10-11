import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const target = process.argv[2];
const key = process.argv[3] ?? `${homedir()}/.ssh/ai-vps-key`;
if (!target || !/^[a-zA-Z0-9_.@:-]+$/.test(target) || target.startsWith('-'))
  throw new Error('Usage: pnpm private:tunnel user@VPS [SSH_KEY_PATH]');
const ssh = ['-i', key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
// Capture the secret directly into a private file. Never print it to the terminal.
let token;
try {
  token = execFileSync(
    'ssh',
    [...ssh, target, 'sudo -n cat /etc/ai-private-llm/token'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ).trim();
} catch {
  // execFileSync errors can contain captured stdout; never print that object.
  console.error(
    'Could not retrieve API key. Check SSH access and sudo permissions.',
  );
  process.exit(1);
}
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid API key file.');
mkdirSync('.local-data/private-llm', { recursive: true, mode: 0o700 });
writeFileSync('.local-data/private-llm/token', `${token}\n`, { mode: 0o600 });
chmodSync('.local-data/private-llm/token', 0o600);
console.log('Key saved to .local-data/private-llm/token (not printed).');
console.log('Chat: http://127.0.0.1:18804 — keep this terminal open.');
const child = spawn(
  'ssh',
  [
    ...ssh,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    '-N',
    '-L',
    '127.0.0.1:18804:127.0.0.1:18804',
    target,
  ],
  { stdio: 'inherit' },
);
for (const name of ['SIGINT', 'SIGTERM'])
  process.on(name, () => child.kill(name));
child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
