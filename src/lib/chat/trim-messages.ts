import type { ModelMessage } from "ai";

const MAX_INPUT_CHARS = 150_000; // ~50k tokens at ~3 chars/token

/**
 * Bounds the model input. Keeps the first message plus the largest suffix
 * of recent messages that fits, then repairs the cut so the suffix never
 * starts with an orphaned tool result.
 *
 * Lives outside the route file so it can be unit tested: extra exports
 * from a route.ts fail Next's route-type validation.
 */
export function trimMessages(messages: ModelMessage[]): ModelMessage[] {
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += JSON.stringify(msg).length;
  }

  if (totalChars <= MAX_INPUT_CHARS) return messages;

  // Keep first message + trim from the middle, keeping recent messages
  const first = messages[0];
  const rest = messages.slice(1);

  // Walk backwards from the end, accumulating messages that fit
  const kept: ModelMessage[] = [];
  let budget = MAX_INPUT_CHARS - JSON.stringify(first).length;

  for (let i = rest.length - 1; i >= 0; i--) {
    const size = JSON.stringify(rest[i]).length;
    if (budget - size < 0) break;
    budget -= size;
    kept.unshift(rest[i]);
  }

  // The cut can land between an assistant tool-call message and its
  // role:'tool' result, leaving the suffix starting with an orphaned
  // tool_result the Anthropic API rejects with a 400. The trim is
  // deterministic, so regenerate hit the identical 400 and the chat was
  // bricked until enough new text moved the boundary. Results always
  // follow their calls, so dropping leading tool messages restores a
  // valid boundary.
  while (kept.length > 0 && kept[0].role === "tool") {
    kept.shift();
  }

  return [first, ...kept];
}
