import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/outreach/activity pagination. The page is ordered by `at` (a
 * reply lifts an old email to the top) while the cursor walks `sent_at`, so
 * a naive "oldest sent_at on the page" cursor can jump past sent rows that
 * were fetched but sliced off: they are then filtered out (sent_at < cursor)
 * on every later page, permanently missing from history.
 */

let sentRows: Array<Record<string, unknown>> = [];
let pendingRows: Array<Record<string, unknown>> = [];

function chain(table: string) {
  const c: Record<string, unknown> & PromiseLike<unknown> = {
    select: () => c,
    order: () => c,
    limit: () => c,
    lt: () => c,
    eq: () => c,
    in: () => c,
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve({
        data: table === "sent_emails" ? sentRows : pendingRows,
        error: null,
      }).then(onF, onR),
  } as unknown as Record<string, unknown> & PromiseLike<unknown>;
  return c;
}

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAndUser: vi.fn(async () => ({
    supabase: { from: (table: string) => chain(table) },
    user: { id: "user-1" },
  })),
}));

import { GET } from "@/app/api/outreach/activity/route";

const sent = (
  id: string,
  sentAt: string,
  replyAt?: string,
): Record<string, unknown> => ({
  id,
  subject: "s",
  to_email: "t@acme.com",
  from_email: "me@me.com",
  status: "sent",
  sent_at: sentAt,
  message_id: null,
  person: null,
  email_replies: replyAt
    ? [{ kind: "reply", body_text: "hi", received_at: replyAt }]
    : [],
});

const pending = (id: string, createdAt: string): Record<string, unknown> => ({
  id,
  subject: "p",
  to_email: "t@acme.com",
  status: "queued",
  created_at: createdAt,
  last_error: null,
  last_error_at: null,
  last_error_kind: null,
  person: null,
  enrollment: null,
});

const get = (limit: number) =>
  GET(new Request(`http://test/api/outreach/activity?limit=${limit}`));

beforeEach(() => {
  sentRows = [];
  pendingRows = [];
});

describe("activity nextCursor", () => {
  it("does not advance past a fetched sent row the page sliced off", async () => {
    // rowOld's reply lifts it to the top of the page; rowNew (never replied)
    // falls below the slice. The old cursor (oldest sent_at on the page) was
    // rowOld's T1, so the next page filtered sent_at < T1 and rowNew (T3)
    // vanished from history forever.
    sentRows = [
      sent("new", "2026-08-03T00:00:00Z"),
      sent("old", "2026-08-01T00:00:00Z", "2026-08-04T00:00:00Z"),
    ];
    pendingRows = [pending("d1", "2026-08-03T12:00:00Z")];

    const res = await get(2);
    const body = (await res.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };

    expect(body.items.map((i) => i.id)).toEqual(["old", "draft:d1"]);
    // The newest fetched sent row was not returned, so the cursor must not
    // move at all: the next page re-fetches it instead of skipping it.
    expect(body.nextCursor).toBeNull();
  });

  it("advances to the oldest fetched sent_at when every sent row was returned", async () => {
    sentRows = [
      sent("new", "2026-08-03T00:00:00Z"),
      sent("old", "2026-08-01T00:00:00Z"),
    ];

    const res = await get(2);
    const body = (await res.json()) as { nextCursor: string | null };

    expect(body.nextCursor).toBe("2026-08-01T00:00:00Z");
  });

  it("returns no cursor when the sent fetch was not full", async () => {
    sentRows = [sent("only", "2026-08-01T00:00:00Z")];

    const res = await get(50);
    const body = (await res.json()) as { nextCursor: string | null };

    expect(body.nextCursor).toBeNull();
  });
});
