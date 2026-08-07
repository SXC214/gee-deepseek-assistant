/**
 * Truncated conversation windows may start mid-exchange, e.g. with an
 * assistant message. OpenAI-compatible chat APIs expect contexts to begin
 * with a user turn, so drop leading non-user messages after truncation.
 * Returns a new array; the input is never mutated.
 */
export function alignConversationToUser(messages) {
  const list = Array.isArray(messages) ? [...messages] : [];
  while (list.length && list[0]?.role !== "user") list.shift();
  return list;
}
