import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptSecret } from "@/lib/crypto";

export interface SenderConfig {
  address: string;
  appPassword: string;
  fromName: string | null;
  replyTo: string | null;
  dailyLimit: number;
  /** When the mailbox was connected — drives the warmup ramp. */
  connectedAt: string | null;
}

const DEFAULT_DAILY_LIMIT = 30;
const NOT_CONNECTED =
  "Email is not configured. Go to Settings > Email and connect your Gmail account.";

/**
 * Single place a user's send identity is resolved from user_settings.
 * Accepts the admin client or an RLS-scoped client (RLS restricts the row to
 * the caller, which is exactly right there).
 */
export async function resolveSenderConfig(
  supabase: SupabaseClient,
  userId: string,
): Promise<SenderConfig | { error: string }> {
  const { data: settings } = await supabase
    .from("user_settings")
    .select(
      "gmail_address, gmail_app_password_enc, gmail_connected_at, from_name, reply_to_email, daily_send_limit",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (!settings?.gmail_address || !settings.gmail_app_password_enc) {
    return { error: NOT_CONNECTED };
  }

  return {
    address: settings.gmail_address,
    appPassword: decryptSecret(settings.gmail_app_password_enc),
    fromName: settings.from_name ?? null,
    replyTo: settings.reply_to_email ?? null,
    dailyLimit: settings.daily_send_limit ?? DEFAULT_DAILY_LIMIT,
    connectedAt: settings.gmail_connected_at ?? null,
  };
}
