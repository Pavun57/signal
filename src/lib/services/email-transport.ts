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
  /** Kill switch from Settings > Email: claimAndSendDraft refuses while true. */
  sendingPaused: boolean;
  /** Send window in sender-local hours; null start/end = send any time. */
  sendWindowStart: number | null;
  sendWindowEnd: number | null;
  sendTimezone: string | null;
  /**
   * Whose clock the window reads: "recipient" resolves each contact's
   * timezone from location data, falling back to sendTimezone when unknown.
   */
  sendWindowScope: "sender" | "recipient";
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
      "gmail_address, gmail_app_password_enc, gmail_connected_at, from_name, reply_to_email, daily_send_limit, sending_paused, send_window_start, send_window_end, send_timezone, send_window_scope",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (!settings?.gmail_address || !settings.gmail_app_password_enc) {
    return { error: NOT_CONNECTED };
  }

  // A rotated EMAIL_CREDENTIALS_KEY or corrupt ciphertext must fail as this
  // user's error, not an exception — a throw here would 500 the multi-tenant
  // followups cron and halt every user's sends.
  let appPassword: string;
  try {
    appPassword = decryptSecret(settings.gmail_app_password_enc);
  } catch {
    return {
      error:
        "Stored Gmail credentials can't be decrypted (encryption key changed?). Reconnect your mailbox in Settings > Email.",
    };
  }

  return {
    address: settings.gmail_address,
    appPassword,
    fromName: settings.from_name ?? null,
    replyTo: settings.reply_to_email ?? null,
    dailyLimit: settings.daily_send_limit ?? DEFAULT_DAILY_LIMIT,
    connectedAt: settings.gmail_connected_at ?? null,
    sendingPaused: settings.sending_paused ?? false,
    sendWindowStart: settings.send_window_start ?? null,
    sendWindowEnd: settings.send_window_end ?? null,
    sendTimezone: settings.send_timezone ?? null,
    sendWindowScope:
      settings.send_window_scope === "recipient" ? "recipient" : "sender",
  };
}
