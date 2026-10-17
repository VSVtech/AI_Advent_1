// Local MCP server «Git»: read-only view of the project repository for the
// developer assistant (current branch, status, changed files, diff, files).
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from '@modelcontextprotocol/server';

import { errorResult, listenMcp, portFromEnv, textResult } from './listen.mjs';

const execFileAsync = promisify(execFile);

export const DEFAULT_REPO_DIR = fileURLToPath(
  new URL('../../', import.meta.url),
);
const MAX_OUTPUT = 20_000;
const MAX_FILES = 300;
// A path must stay inside the repository and never look like a git option.
const SAFE_PATH = /^(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\n]{1,300}$/u;

async function git(repoDir, args) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoDir,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10_000,
    });
    return stdout;
  } catch (error) {
    throw new Error(
      `git ${args[0]} не выполнился: ${String(error?.stderr || error?.message).trim().slice(0, 200)}`,
    );
  }
}

function cut(text) {
  return text.length > MAX_OUTPUT
    ? { text: text.slice(0, MAX_OUTPUT), truncated: true }
    : { text, truncated: false };
}

export async function currentBranch(repoDir) {
  const branch = (await git(repoDir, ['branch', '--show-current'])).trim();
  if (branch) return { branch, detached: false };
  const head = (await git(repoDir, ['rev-parse', '--short', 'HEAD'])).trim();
  return { branch: head, detached: true };
}

export async function gitStatus(repoDir) {
  const out = await git(repoDir, ['status', '--short', '--branch']);
  const [branchLine, ...files] = out.trim().split('\n');
  return { branch: branchLine.replace(/^## /u, ''), changes: files.filter(Boolean) };
}

export async function changedFiles(repoDir, base) {
  if (base !== undefined && !/^[\w./-]{1,100}$/u.test(base)) {
    throw new Error('Некорректное имя ветки или коммита');
  }
  // With a base: files changed since the merge-base; without: uncommitted ones.
  const args = base
    ? ['diff', '--name-status', `${base}...HEAD`]
    : ['diff', '--name-status', 'HEAD'];
  const out = await git(repoDir, args);
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...path] = line.split('\t');
      return { status, path: path.join(' → ') };
    });
}

export async function gitDiff(repoDir, { base, path } = {}) {
  if (base !== undefined && !/^[\w./-]{1,100}$/u.test(base)) {
    throw new Error('Некорректное имя ветки или коммита');
  }
  if (path !== undefined && !SAFE_PATH.test(path)) {
    throw new Error('Некорректный путь');
  }
  const args = ['diff', '--no-color', base ? `${base}...HEAD` : 'HEAD'];
  if (path) args.push('--', path);
  return cut(await git(repoDir, args));
}

export async function listFiles(repoDir, directory) {
  if (directory !== undefined && !SAFE_PATH.test(directory)) {
    throw new Error('Некорректный путь');
  }
  const args = ['ls-files'];
  if (directory) args.push('--', directory);
  const files = (await git(repoDir, args)).trim().split('\n').filter(Boolean);
  return { total: files.length, files: files.slice(0, MAX_FILES) };
}

export function createGitMcpHandler({
  repoDir = process.env.GIT_REPO_DIR ?? DEFAULT_REPO_DIR,
} = {}) {
  const tool = (mcp, name, description, properties, run) =>
    mcp.registerTool(
      name,
      {
        description,
        inputSchema: fromJsonSchema({
          type: 'object',
          properties,
          additionalProperties: false,
        }),
      },
      async (args) => {
        try {
          return textResult(await run(args ?? {}));
        } catch (error) {
          return errorResult(error, 'Не удалось выполнить git-команду');
        }
      },
    );
  return createMcpHandler(() => {
    const mcp = new McpServer({ name: 'ai-challenge-git', version: '1.0.0' });
    tool(
      mcp,
      'git_current_branch',
      'Текущая git-ветка проекта (или короткий хеш коммита при detached HEAD)',
      {},
      () => currentBranch(repoDir),
    );
    tool(
      mcp,
      'git_status',
      'Ветка и список незакоммиченных изменений проекта (git status --short)',
      {},
      () => gitStatus(repoDir),
    );
    tool(
      mcp,
      'git_changed_files',
      'Изменённые файлы: незакоммиченные или относительно ветки base (например main)',
      {
        base: {
          type: 'string',
          description: 'Ветка или коммит для сравнения, например main',
        },
      },
      ({ base }) => changedFiles(repoDir, base),
    );
    tool(
      mcp,
      'git_diff',
      'Diff изменений проекта: незакоммиченных или относительно ветки base; можно для одного файла',
      {
        base: { type: 'string', description: 'Ветка или коммит, например main' },
        path: { type: 'string', description: 'Путь файла внутри проекта' },
      },
      (args) => gitDiff(repoDir, args),
    );
    tool(
      mcp,
      'git_list_files',
      'Список файлов проекта под контролем git; можно ограничить каталогом',
      {
        directory: {
          type: 'string',
          description: 'Каталог внутри проекта, например lib',
        },
      },
      ({ directory }) => listFiles(repoDir, directory),
    );
    return mcp;
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await listenMcp(createGitMcpHandler(), {
    name: 'Git',
    port: portFromEnv('MCP_GIT_PORT', 18805),
  });
}
