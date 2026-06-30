// Shared assistant-event text extraction used by every adapter. Both the
// standalone-client and llm-mediated adapters receive AssistantMessage events
// whose payload may carry `content` as a plain string or as an array of parts
// (each part a string or a `{ text }` object). Normalise every shape to a
// single string so the rest of the runtime only ever sees `output.text`.

/**
 * @param {{ data?: { content?: unknown }, content?: unknown } | null | undefined} assistantEvent
 * @returns {string}
 */
export function extractText(assistantEvent) {
  if (!assistantEvent) return "";
  const data = assistantEvent.data ?? assistantEvent;
  if (typeof data?.content === "string") return data.content;
  if (Array.isArray(data?.content)) {
    return data.content
      .map((c) => (typeof c === "string" ? c : c?.text ?? ""))
      .join("");
  }
  return "";
}
