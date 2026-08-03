import { NextResponse } from "next/server";
import { getSupabaseAndUser } from "@/lib/supabase/server";
import { encryptSecret } from "@/lib/crypto";
import {
  getEffectiveDailyLimit,
  verifyGmailCredentials,
} from "@/lib/services/gmail-service";

// Connecting runs a live SMTP + IMAP login against Gmail, which takes a few
// seconds — don't let the default function budget cut it off.
export const maxDuration = 30;

export async function GET() {
  const ctx = await getSupabaseAndUser();
  if (!ctx)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { supabase, user } = ctx;

  const { data: settings } = await supabase
    .from("user_settings")
    .select(
      "gmail_address, gmail_connected_at, from_name, reply_to_email, daily_send_limit, sending_paused",
    )
    .eq("user_id", user.id)
    .maybeSingle();

  const dailyLimit = settings?.daily_send_limit ?? 30;

  return NextResponse.json({
    settings: settings ?? {
      gmail_address: null,
      gmail_connected_at: null,
      from_name: null,
      reply_to_email: null,
      daily_send_limit: 30,
      sending_paused: false,
    },
    is_configured: !!settings?.gmail_address,
    effective_daily_limit: getEffectiveDailyLimit(
      settings?.gmail_connected_at ?? null,
      dailyLimit,
    ),
  });
}

export async function POST(request: Request) {
  const ctx = await getSupabaseAndUser();
  if (!ctx)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { supabase, user } = ctx;
  const body = await request.json();

  if (body.action === "connect_gmail") {
    const address =
      typeof body.gmail_address === "string" ? body.gmail_address.trim() : "";
    const appPassword =
      typeof body.app_password === "string"
        ? body.app_password.replace(/\s+/g, "")
        : "";
    if (
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) ||
      appPassword.length < 16
    ) {
      return NextResponse.json(
        {
          error:
            "A valid email address and 16-character app password are required.",
        },
        { status: 400 },
      );
    }

    const verified = await verifyGmailCredentials({ address, appPassword });
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, { status: 400 });
    }

    // Preserve the warmup-ramp clock when re-connecting the same address
    // (e.g. after rotating the app password).
    const { data: existing } = await supabase
      .from("user_settings")
      .select("gmail_address, gmail_connected_at")
      .eq("user_id", user.id)
      .maybeSingle();
    const connectedAt =
      existing?.gmail_address === address && existing?.gmail_connected_at
        ? existing.gmail_connected_at
        : new Date().toISOString();

    const { error } = await supabase.from("user_settings").upsert(
      {
        user_id: user.id,
        gmail_address: address,
        gmail_app_password_enc: encryptSecret(appPassword),
        gmail_connected_at: connectedAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ connected: true, gmail_address: address });
  }

  // Kill switch. Its own action rather than part of the plain settings save,
  // so toggling is atomic and can never be lost to a half-filled form.
  if (body.action === "set_sending_paused") {
    if (typeof body.paused !== "boolean") {
      return NextResponse.json(
        { error: "paused must be a boolean" },
        { status: 400 },
      );
    }
    const { error } = await supabase.from("user_settings").upsert(
      {
        user_id: user.id,
        sending_paused: body.paused,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ sending_paused: body.paused });
  }

  if (body.action === "disconnect_gmail") {
    const { error } = await supabase
      .from("user_settings")
      .update({
        gmail_address: null,
        gmail_app_password_enc: null,
        gmail_connected_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ disconnected: true });
  }

  // Plain settings save
  const fields: Record<string, unknown> = {
    user_id: user.id,
    from_name: body.from_name ?? null,
    reply_to_email: body.reply_to_email ?? null,
    updated_at: new Date().toISOString(),
  };

  if (body.daily_send_limit !== undefined) {
    const limit = Number(body.daily_send_limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return NextResponse.json(
        { error: "daily_send_limit must be an integer between 1 and 500" },
        { status: 400 },
      );
    }
    fields.daily_send_limit = limit;
  }

  const { error } = await supabase.from("user_settings").upsert(fields, {
    onConflict: "user_id",
  });

  if (error) {
    return NextResponse.json(
      { error: `Failed to save settings: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ saved: true });
}
