"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";

import { apiFetch } from "@/lib/api-fetch";
import { RelativeTime } from "@/components/ui/relative-time";

interface DetailPayload {
  sent: {
    subject: string;
    to_email: string;
    from_email: string | null;
    sent_at: string;
    status: string;
    body_text: string | null;
    body_available: boolean;
  };
  replies: Array<{
    kind: string;
    from_email: string;
    subject: string;
    received_at: string;
    body_text: string | null;
  }>;
  gmail_url: string | null;
}

/**
 * The expanded half of an activity row: what we sent, and everything that came
 * back.
 *
 * Fetched on first expand rather than with the list, because the list rides a
 * 10-second poll and email bodies have no business being re-fetched every ten
 * seconds.
 *
 * Bodies render as plain text in a pre-wrap block. Nothing in this app uses
 * dangerouslySetInnerHTML and this does not start: reply text arrives from
 * strangers, and our own sent HTML is only <p>/<br>/<a>, which the server has
 * already flattened while keeping link targets visible.
 */
export function ActivityDetail({
  id,
  error,
}: {
  id: string;
  error: { kind: string; message: string; at: string } | null;
}) {
  const [data, setData] = useState<DetailPayload | null>(null);
  // Starts as "loading" rather than being set to it inside the effect: this
  // component only mounts when a row is expanded, so loading IS its initial
  // state, and setting it in the effect body is a cascading render.
  const [state, setState] = useState<"idle" | "loading" | "failed">("loading");

  // A pending draft has no sent_emails row, so there is nothing to fetch. Its
  // whole story is the error already handed down from the list.
  const isPending = id.startsWith("draft:");

  useEffect(() => {
    if (isPending || data) return;
    let cancelled = false;
    apiFetch(`/api/outreach/activity/${id}`)
      .then((r) => r.json())
      .then((payload: DetailPayload) => {
        if (!cancelled) {
          setData(payload);
          setState("idle");
        }
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [id, isPending, data]);

  if (error) {
    return (
      <div className="space-y-2 px-4 py-3">
        <p className="text-sm font-medium">
          {error.kind === "deferred"
            ? "Waiting for tomorrow"
            : error.kind === "blocked"
              ? "Blocked before sending"
              : "The send failed"}
        </p>
        {/* Verbatim. These sentences are written for a person to read and say
            what to do about it, so paraphrasing them here loses the fix. */}
        <p className="text-muted-foreground text-sm">{error.message}</p>
        <p className="text-muted-foreground text-xs">
          <RelativeTime iso={error.at} />
        </p>
      </div>
    );
  }

  if (isPending) {
    return (
      <p className="text-muted-foreground px-4 py-3 text-sm">
        Approved and waiting to send. Nothing has left yet.
      </p>
    );
  }

  if (state === "loading") {
    return (
      <p className="text-muted-foreground flex items-center gap-2 px-4 py-3 text-sm">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading the message...
      </p>
    );
  }

  if (state === "failed" || !data) {
    return (
      <p className="text-muted-foreground px-4 py-3 text-sm">
        Could not load this message.
      </p>
    );
  }

  return (
    <div className="space-y-4 px-4 py-3">
      <section className="space-y-1.5">
        <div className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
          <span>To {data.sent.to_email}</span>
          {data.sent.from_email && <span>from {data.sent.from_email}</span>}
          <RelativeTime iso={data.sent.sent_at} />
        </div>
        <p className="text-sm font-medium">{data.sent.subject}</p>
        {data.sent.body_available ? (
          <p className="text-muted-foreground text-sm whitespace-pre-wrap">
            {data.sent.body_text}
          </p>
        ) : (
          // sent_emails.draft_id is ON DELETE SET NULL and drafts cascade from
          // sequences, so deleting a sequence destroys the body while the send
          // record survives. Say so rather than rendering an empty email.
          <p className="text-muted-foreground text-sm italic">
            This email&apos;s body is no longer stored.
          </p>
        )}
      </section>

      {data.replies.map((reply, i) => (
        <section
          key={`${reply.received_at}-${i}`}
          className="border-border space-y-1.5 border-l-2 pl-3"
        >
          <div className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
            <span className="font-medium">
              {reply.kind === "bounce" ? "Bounced" : reply.from_email}
            </span>
            <RelativeTime iso={reply.received_at} />
          </div>
          {reply.body_text ? (
            <p className="text-sm whitespace-pre-wrap">{reply.body_text}</p>
          ) : (
            // Distinct from an empty reply: we matched the message but never
            // captured its words, which is the permanent state for anything
            // that replied before capture existed.
            <p className="text-muted-foreground text-sm italic">
              We know this arrived but did not capture the text. Open it in
              Gmail to read it.
            </p>
          )}
        </section>
      ))}

      {data.gmail_url ? (
        <a
          href={data.gmail_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary inline-flex items-center gap-1 text-xs font-medium hover:underline"
        >
          Open in Gmail
          <ExternalLink className="h-3 w-3" />
        </a>
      ) : (
        <p
          className="text-muted-foreground text-xs"
          title="No Message-ID was recorded for this send, so there is nothing to look up."
        >
          No Gmail link for this one
        </p>
      )}
    </div>
  );
}
