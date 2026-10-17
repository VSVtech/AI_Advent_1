export type SupportTicket = {
  id: string;
  subject: string;
  status: string;
  createdAt: string;
  userId: string;
  userName: string;
};

export const SUPPORT_QUESTIONS = [
  'Почему не работает авторизация?',
  'Что ответить пользователю?',
  'Можно ли решить это без передачи специалисту?',
] as const;

// The desk sends the same /support command that works in any agent chat.
export function supportCommand(ticketId: string | null, question: string) {
  return `/support ${ticketId ?? ''} ${question}`.replace(/\s+/gu, ' ').trim();
}
