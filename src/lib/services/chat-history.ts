import type { SupabaseClient } from "@supabase/supabase-js";
import type { UIMessage } from "ai";

// ---------------------------------------------------------------------------
// Title generation (pure function, no LLM call)
// ---------------------------------------------------------------------------

function generateTitle(messages: UIMessage[]): string {
  const firstUserMsg = messages.find((m) => m.role === "user");
  if (!firstUserMsg) return "New chat";

  const text = firstUserMsg.parts
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();

  if (!text) return "New chat";
  if (text.length <= 80) return text;
  const truncated = text.slice(0, 77).replace(/\s+\S*$/, "");
  return truncated ? `${truncated}...` : `${text.slice(0, 77)}...`;
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export interface ChatSummary {
  id: string;
  title: string;
  campaign_id: string | null;
  updated_at: string;
}

export async function saveChat(
  supabase: SupabaseClient,
  userId: string,
  chatId: string,
  messages: UIMessage[],
  campaignId?: string,
): Promise<void> {
  // Keep an existing title. The server-side save runs on EVERY turn, and
  // regenerating from the first user message clobbered the LLM title that
  // /api/chat/summarize had written: titles flipped back to the raw prompt
  // mid-session and stayed reverted if the session ended without the
  // tab-hide re-summarize. The auto title is only for brand-new chats.
  const { data: existing } = await supabase
    .from("chats")
    .select("title")
    .eq("id", chatId)
    .maybeSingle();
  const title = existing?.title?.trim()
    ? (existing.title as string)
    : generateTitle(messages);

  const { error } = await supabase.from("chats").upsert(
    {
      id: chatId,
      title,
      campaign_id: campaignId ?? null,
      messages: JSON.parse(JSON.stringify(messages)),
      updated_at: new Date().toISOString(),
      user_id: userId,
    },
    { onConflict: "id" },
  );

  if (error) console.error("[chat-history] save failed:", error.message);
}

export interface LoadedChat {
  id: string;
  title: string;
  campaign_id: string | null;
  messages: UIMessage[];
}

/**
 * "Query failed" and "no such chat" are DIFFERENT answers and must never
 * be conflated: rendering a load failure as a fresh empty chat meant the
 * very next send overwrote the stored history with only the new turn.
 * ok:false = do not render, and above all do not save.
 */
export async function loadChat(
  supabase: SupabaseClient,
  chatId: string,
): Promise<
  { ok: true; chat: LoadedChat | null } | { ok: false; error: string }
> {
  const { data, error } = await supabase
    .from("chats")
    .select("id, title, campaign_id, messages")
    .eq("id", chatId)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  return { ok: true, chat: (data as LoadedChat | null) ?? null };
}

export async function loadCampaignChat(
  supabase: SupabaseClient,
  campaignId: string,
): Promise<{ id: string; messages: UIMessage[] } | null> {
  const { data } = await supabase
    .from("chats")
    .select("id, messages")
    .eq("campaign_id", campaignId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .single();

  if (!data) return null;
  return data as { id: string; messages: UIMessage[] };
}

export async function listChats(
  supabase: SupabaseClient,
  limit = 30,
): Promise<ChatSummary[] | null> {
  const { data, error } = await supabase
    .from("chats")
    .select("id, title, campaign_id, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);

  // null = the query failed; [] = genuinely no chats. The list page renders
  // them differently, because "your history is gone" must never look like
  // "you have no history".
  if (error) {
    console.error("[chat-history] listChats failed:", error.message);
    return null;
  }
  return (data as ChatSummary[]) ?? [];
}

export async function deleteChat(
  supabase: SupabaseClient,
  chatId: string,
): Promise<void> {
  await supabase.from("chats").delete().eq("id", chatId);
}
