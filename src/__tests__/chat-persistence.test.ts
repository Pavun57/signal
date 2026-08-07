import { describe, expect, it } from "vitest";
import type { ModelMessage, UIMessage } from "ai";

import { trimMessages } from "@/lib/chat/trim-messages";
import { loadChat, saveChat } from "@/lib/services/chat-history";

// ── trimMessages boundary repair ───────────────────────────────────────────

function bigText(role: "user" | "assistant", chars: number): ModelMessage {
  return { role, content: "x".repeat(chars) } as ModelMessage;
}

describe("trimMessages", () => {
  it("never lets the kept suffix start with an orphaned tool result", () => {
    // Build a history big enough to trim, where the natural cut lands
    // between an assistant tool-call message and its role:'tool' result.
    // Sending that suffix produced a deterministic Anthropic 400
    // (unexpected tool_use_id) and the chat was bricked: regenerate
    // reproduced the identical trim.
    const history: ModelMessage[] = [
      bigText("user", 1000), // kept first message
      bigText("assistant", 120_000), // crowds out most of the budget
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "findContacts",
            input: { q: "x".repeat(20_000) },
          },
        ],
      } as ModelMessage,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "findContacts",
            output: { type: "text", value: "y".repeat(20_000) },
          },
        ],
      } as ModelMessage,
      bigText("assistant", 4000),
      bigText("user", 200),
    ];

    const trimmed = trimMessages(history);

    expect(trimmed.length).toBeLessThan(history.length);
    // No message after the first may be a tool result whose call was cut.
    const suffix = trimmed.slice(1);
    expect(suffix[0]?.role).not.toBe("tool");
    for (let i = 0; i < suffix.length; i++) {
      if (suffix[i].role !== "tool") continue;
      const prev = suffix[i - 1];
      expect(prev?.role).toBe("assistant");
    }
  });

  it("returns short histories untouched", () => {
    const history = [bigText("user", 100), bigText("assistant", 100)];
    expect(trimMessages(history)).toEqual(history);
  });
});

// ── saveChat title preservation / loadChat contract ────────────────────────

interface RecordedCall {
  table: string;
  ops: Array<{ name: string; args: unknown[] }>;
}

function fakeSupabase(responses: Array<{ data?: unknown; error?: unknown }>) {
  let i = 0;
  const calls: RecordedCall[] = [];
  const from = (table: string) => {
    const call: RecordedCall = { table, ops: [] };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq", "upsert", "maybeSingle", "single"]) {
      builder[name] = (...args: unknown[]) => {
        call.ops.push({ name, args });
        return builder;
      };
    }
    builder.then = (
      resolve: (v: unknown) => unknown,
      reject: (e: unknown) => unknown,
    ) =>
      Promise.resolve(responses[i++] ?? { data: null, error: null }).then(
        resolve,
        reject,
      );
    return builder;
  };
  return { calls, client: { from } as never };
}

const userMessage: UIMessage = {
  id: "m1",
  role: "user",
  parts: [{ type: "text", text: "find me UK fintech CMOs" }],
} as UIMessage;

describe("saveChat title", () => {
  it("keeps an existing title instead of regenerating from the first message", async () => {
    // The server-side save runs every turn; regenerating clobbered the
    // LLM title written by /api/chat/summarize back to the raw prompt.
    const { calls, client } = fakeSupabase([
      { data: { title: "UK fintech CMO hunt" } }, // existing row
      {}, // upsert
    ]);

    await saveChat(client, "user_1", "chat_1", [userMessage]);

    const upsert = calls
      .flatMap((c) => c.ops)
      .find((op) => op.name === "upsert");
    expect((upsert?.args[0] as { title: string }).title).toBe(
      "UK fintech CMO hunt",
    );
  });

  it("generates the auto title only for brand-new chats", async () => {
    const { calls, client } = fakeSupabase([
      { data: null }, // no existing row
      {}, // upsert
    ]);

    await saveChat(client, "user_1", "chat_1", [userMessage]);

    const upsert = calls
      .flatMap((c) => c.ops)
      .find((op) => op.name === "upsert");
    expect((upsert?.args[0] as { title: string }).title).toBe(
      "find me UK fintech CMOs",
    );
  });
});

describe("loadChat", () => {
  it("distinguishes a failed query from a missing chat", async () => {
    // Conflating them rendered an existing conversation as a fresh empty
    // chat, and the next send overwrote the stored history.
    const failed = fakeSupabase([
      { data: null, error: { message: "connection reset" } },
    ]);
    await expect(loadChat(failed.client, "chat_1")).resolves.toEqual({
      ok: false,
      error: "connection reset",
    });

    const missing = fakeSupabase([{ data: null }]);
    await expect(loadChat(missing.client, "chat_1")).resolves.toEqual({
      ok: true,
      chat: null,
    });
  });
});
