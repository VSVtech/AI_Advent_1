// /help — команда ассистента разработчика: ответ о проекте по документации
// (RAG) и текущему состоянию репозитория (MCP-сервер git).
export const HELP_DEFAULT_QUESTION =
  'Кратко расскажи, что это за проект, как он устроен и где что лежит.';

export const HELP_PROMPT = [
  'Команда /help: ты — ассистент разработчика этого проекта и отвечаешь на вопрос о нём.',
  'Опирайся на фрагменты документации и кода из RAG_CONTEXT и ссылайся на файлы-источники. Не выдумывай то, чего в них нет: если ответа нет, скажи об этом.',
  'Если вопрос касается текущего состояния репозитория (ветка, изменённые файлы, diff), вызови инструменты git: git_current_branch, git_status, git_changed_files, git_diff. Состояние репозитория бери только из них, а не из документации.',
  'Для вопроса о структуре проекта можно вызвать git_list_files.',
].join('\n');

export function parseHelpCommand(content: string): string | null {
  const match = /^\/help(?:\s+([\s\S]*))?$/iu.exec(content.trim());
  if (!match) return null;
  return match[1]?.trim() || HELP_DEFAULT_QUESTION;
}
