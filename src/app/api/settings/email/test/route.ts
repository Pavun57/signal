import { NextResponse } from "next/server";

import { decryptSecret } from "@/lib/crypto";
import {
  checkTestCooldown,
  extractReplyText,
  matchTestReply,
  validateTestRecipient,
} from "@/lib/services/email-test";
import type { InboundSummary } from "@/lib/services/gmail-service";
import {
  fetchInboundSince,
  fetchMessageText,
  sendGmailMessage,
} from "@/lib/services/gmail-service";
import { getSupabaseAndUser } from "@/lib/supabase/server";

// The IMAP socket timeout is 60s, so the settings route's 30 is not enough
// for a check that has to connect, fetch and log out.
export const maxDuration = 60;

const TEST_SUBJECT = "Signal test send";

const SELECT =
  "gmail_address, gmail_app_password_enc, from_name, reply_to_email, test_message_id, test_to_email, test_sent_at, test_replied_at, test_status, test_reply";

type Settings = {
  gmail_address: string | null;
  gmail_app_password_enc: string | null;
  from_name: string | null;
  reply_to_email: string | null;
  test_message_id: string | null;
  test_to_email: string | null;
  test_sent_at: string | null;
  test_replied_at: string | null;
  test_status: "replied" | "bounced" | null;
  test_reply: TestReplyDetail | null;
};

type TestReplyDetail = {
  from: string;
  subject: string;
  at: string;
  snippet: string;
};

function testState(settings: Settings) {
  return {
    to_email: settings.test_to_email,
    sent_at: settings.test_sent_at,
    replied_at: settings.test_replied_at,
    status: settings.test_status,
    reply: settings.test_reply,
  };
}

export async function GET() {
  const ctx = await getSupabaseAndUser();
  if (!ctx)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { supabase, user } = ctx;

  const { data } = await supabase
    .from("user_settings")
    .select(SELECT)
    .eq("user_id", user.id)
    .maybeSingle();

  const settings = (data ?? null) as Settings | null;
  const connected = settings?.gmail_address ?? null;

  // Pre-fill with something that is definitely NOT the connected address,
  // since a test to yourself can never resolve.
  const candidate = settings?.reply_to_email || user.email || "";
  const suggested =
    candidate.toLowerCase() === (connected ?? "").toLowerCase()
      ? ""
      : candidate;

  return NextResponse.json({
    connected,
    suggested_to: settings?.test_to_email || suggested,
    test: settings ? testState(settings) : null,
  });
}

export async function POST(request: Request) {
  const ctx = await getSupabaseAndUser();
  if (!ctx)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { supabase, user } = ctx;
  const body = await request.json();

  const { data } = await supabase
    .from("user_settings")
    .select(SELECT)
    .eq("user_id", user.id)
    .maybeSingle();
  const settings = (data ?? null) as Settings | null;

  if (!settings?.gmail_address || !settings.gmail_app_password_enc) {
    return NextResponse.json(
      { error: "Connect a Gmail mailbox before sending a test." },
      { status: 400 },
    );
  }

  let appPassword: string;
  try {
    appPassword = decryptSecret(settings.gmail_app_password_enc);
  } catch {
    return NextResponse.json(
      {
        error:
          "Stored credential could not be decrypted. Reconnect your mailbox in Settings > Email.",
      },
      { status: 400 },
    );
  }
  const creds = { address: settings.gmail_address, appPassword };

  if (body.action === "send") {
    const valid = validateTestRecipient(
      typeof body.to === "string" ? body.to : "",
      settings.gmail_address,
    );
    if (!valid.ok) {
      return NextResponse.json({ error: valid.error }, { status: 400 });
    }

    const cooldown = checkTestCooldown(settings.test_sent_at);
    if (!cooldown.ok) {
      return NextResponse.json(
        {
          error: `Wait ${cooldown.retryAfterSeconds}s before sending another test.`,
        },
        {
          status: 429,
          headers: { "Retry-After": String(cooldown.retryAfterSeconds) },
        },
      );
    }

    let messageId: string;
    try {
      // Deliberately writes no sent_emails row: a test must stay invisible to
      // warmup cap counting, campaign stats and the reply-tracking cron.
      const sent = await sendGmailMessage(creds, {
        fromName: settings.from_name,
        to: valid.to,
        subject: TEST_SUBJECT,
        html: "<p>This is a test send from Signal. Reply to this email and Signal should detect your reply within a minute.</p>",
        text: "This is a test send from Signal. Reply to this email and Signal should detect your reply within a minute.",
        replyTo: settings.reply_to_email ?? undefined,
      });
      messageId = sent.messageId;
    } catch (err) {
      const message = err instanceof Error ? err.message : "SMTP send failed";
      return NextResponse.json({ error: message }, { status: 502 });
    }

    const sentAt = new Date().toISOString();
    await supabase
      .from("user_settings")
      .update({
        test_message_id: messageId,
        test_to_email: valid.to,
        test_sent_at: sentAt,
        test_replied_at: null,
        // Clear the previous verdict and its reply detail too, or a new test
        // inherits the old one's status and settles the moment it is checked.
        test_status: null,
        test_reply: null,
        updated_at: sentAt,
      })
      .eq("user_id", user.id);

    return NextResponse.json({
      sent: true,
      test: {
        to_email: valid.to,
        sent_at: sentAt,
        replied_at: null,
        status: null,
      },
    });
  }

  if (body.action === "check") {
    if (!settings.test_message_id || !settings.test_sent_at) {
      return NextResponse.json(
        { error: "No test send to check." },
        { status: 400 },
      );
    }
    // Already settled — never re-scan IMAP for a finished test. Report the
    // stored verdict, not a hardcoded "replied": a bounced test reported as
    // replied would tell the user tracking works when nothing was delivered.
    if (settings.test_replied_at) {
      return NextResponse.json({
        status: settings.test_status ?? "replied",
        reply: settings.test_reply,
        test: testState(settings),
      });
    }

    let inbound: InboundSummary[];
    try {
      inbound = await fetchInboundSince(creds, new Date(settings.test_sent_at));
    } catch {
      // Soft failure: the UI keeps waiting and polling rather than showing
      // the test as broken because one IMAP connect blipped.
      return NextResponse.json({
        status: "waiting",
        warning: "Could not reach Gmail over IMAP. Will retry.",
        test: testState(settings),
      });
    }

    const hit = matchTestReply(
      inbound,
      settings.test_message_id,
      settings.gmail_address,
    );
    if (!hit) {
      return NextResponse.json({
        status: "waiting",
        test: testState(settings),
      });
    }

    const repliedAt = (hit.date ?? new Date()).toISOString();

    // Pull the reply's own words so the user can confirm this is genuinely
    // their message and not an echo of the test we sent. Only for real
    // replies: a bounce body is a delivery report, not something to quote.
    // A failed body fetch costs the excerpt, never the verdict.
    let snippet = "";
    if (hit.status === "replied" && hit.uid !== null) {
      snippet = extractReplyText(await fetchMessageText(creds, hit.uid));
    }

    const reply: TestReplyDetail = {
      from: hit.fromAddress,
      subject: hit.subject,
      at: repliedAt,
      snippet,
    };

    await supabase
      .from("user_settings")
      .update({
        test_replied_at: repliedAt,
        test_status: hit.status,
        test_reply: reply,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id);

    return NextResponse.json({
      status: hit.status,
      reply,
      test: {
        ...testState(settings),
        replied_at: repliedAt,
        status: hit.status,
        reply,
      },
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
