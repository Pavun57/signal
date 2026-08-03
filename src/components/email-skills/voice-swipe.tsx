"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  FIRST_BATCH,
  MAX_JUDGED,
  MIN_JUDGED,
  PHRASE,
  REFILL,
  STALL_STREAK,
  STALL_TURNS,
  TARGET_RATE,
  WINDOW,
  converged,
  deriveRules,
  dominant,
  needed,
  readSeconds,
  rolling,
  streak,
  verbFor,
  type AttrKey,
  type SwipeEmail,
  type Verdict,
} from "@/lib/voice-swipe";

interface Message {
  who: "agent" | "you";
  text: string;
  /** Marks a remark that changed the deck, rather than one that just noticed. */
  applied?: boolean;
}

interface Mark {
  text: string;
  note: string;
}

interface Stall {
  reason: "streak" | "turns";
  n: number;
}

/**
 * Quick answers phrased as instructions rather than labels, so they run through
 * exactly the pipeline a typed message does. A prompt that asks what is wrong
 * and then changes nothing is worse than no prompt at all.
 */
const STALL_QUICK = [
  "They're all too long",
  "Too salesy",
  "Too formal",
  "Never open with a compliment",
  "None of them sound like me",
];

/**
 * Measurements ported verbatim from the published prototype rather than
 * re-approximated in Tailwind scale steps, which is where the drift came from:
 * p-5 for 22px, text-xs for 0.6875rem, and a /25 alpha border for a solid
 * #d8d3d4 all read as "close enough" in isolation and compound into a different
 * component. Arbitrary values here are deliberate.
 */
const PANE_DECK = "bg-card p-[26px]";
const CARD = "rounded-[calc(var(--radius)+2px)] p-[26px_26px_22px]";
/** The prototype's `--divider`, now a real token in globals.css. */
const BORDER_STRONG = "border-border-strong";

/** Server shape. `axes` mirrors EmailAttrs but arrives as plain strings. */
interface ApiDraft {
  subject: string;
  body: string;
  axes: SwipeEmail["attrs"];
}

/** The prospect the server chose for this run. Null when it could not find one. */
interface ApiRecipient {
  personId: string;
  label: string | null;
}

let draftSeq = 0;
function toEmail(d: ApiDraft): SwipeEmail {
  draftSeq += 1;
  return {
    id: `g${draftSeq}`,
    subject: d.subject,
    body: d.body,
    words: d.body.trim().split(/\s+/).filter(Boolean).length,
    attrs: d.axes,
  };
}

export function VoiceSwipe({
  campaignId = null,
}: {
  campaignId?: string | null;
}) {
  const [queue, setQueue] = useState<SwipeEmail[]>([]);
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [judgedEmails, setJudgedEmails] = useState<SwipeEmail[]>([]);
  const [thread, setThread] = useState<Message[]>([]);
  const [said, setSaid] = useState<Record<string, true>>({});
  const [marks, setMarks] = useState<Record<string, Mark[]>>({});
  const [draft, setDraft] = useState("");
  const [stall, setStall] = useState<Stall | null>(null);
  const [stallAt, setStallAt] = useState(0);
  const [turnCheck, setTurnCheck] = useState(STALL_TURNS);
  const [finished, setFinished] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [leaving, setLeaving] = useState<"left" | "right" | null>(null);
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(
    null,
  );
  const [selNote, setSelNote] = useState<string | null>(null);

  /** True once the first batch has landed; gates the "ran out of drafts" end. */
  const [opened, setOpened] = useState(false);
  /** "opening" is the cold start; "rewriting" is a reply to something typed. */
  const [pending, setPending] = useState<"opening" | "rewriting" | null>(
    "opening",
  );
  const [error, setError] = useState<string | null>(null);
  /** The rules the model wrote, once `complete` has saved them. */
  const [skill, setSkill] = useState<{
    instructions: string;
    summary: string;
  } | null>(null);
  const [skillState, setSkillState] = useState<"idle" | "saving" | "failed">(
    "idle",
  );
  const savedRef = useRef(false);

  const threadRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const openingRef = useRef(false);

  /**
   * The prospect every draft in this run is written about. The server picks
   * them on the opening batch; from then on we send the id back so it re-reads
   * the same person, and we never overwrite it.
   *
   * Held in a ref rather than state on purpose. It has to stay out of
   * `fetchBatch`'s dependency list — if the identity of that callback changed
   * the moment a recipient arrived, the effects keyed on it would re-run — and
   * more importantly a recipient that can change mid-run breaks the whole
   * measurement: a keep or a pass would then be about the prospect rather than
   * about the voice, which is the only thing this flow measures. The label is
   * mirrored into state solely so the card can render it.
   */
  const recipientRef = useRef<string | null>(null);
  const [recipientLabel, setRecipientLabel] = useState<string | null>(null);

  const kept = judgedEmails.filter((_, i) => verdicts[i]?.liked);
  const passed = judgedEmails.filter((_, i) => !verdicts[i]?.liked);
  const roll = rolling(verdicts);
  // A pending request must not read as "ran out of drafts" — the queue is
  // legitimately empty while the model is writing the next batch.
  const done =
    finished ||
    converged(verdicts) ||
    (queue.length === 0 && !pending && opened && !error);

  /** The transcript is the whole memory: swipes, phrase notes, typed lines. */
  const buildTranscript = useCallback(
    (extraInstruction?: string) => ({
      judged: judgedEmails.map((e, i) => ({
        subject: e.subject,
        body: e.body,
        axes: e.attrs,
        kept: Boolean(verdicts[i]?.liked),
        notes: marks[e.id],
      })),
      instructions: [
        ...thread.filter((m) => m.who === "you").map((m) => m.text),
        ...(extraInstruction ? [extraInstruction] : []),
      ],
    }),
    [judgedEmails, marks, thread, verdicts],
  );

  const fetchBatch = useCallback(
    async (
      mode: "opening" | "rewriting",
      count: number,
      extraInstruction?: string,
    ): Promise<SwipeEmail[]> => {
      setPending(mode);
      setError(null);
      try {
        const res = await fetch("/api/email-skills/swipe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "next",
            transcript: buildTranscript(extraInstruction),
            campaignId,
            recipientPersonId: recipientRef.current,
            count,
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.drafts?.length) {
          setError(data?.error ?? "Could not write the next drafts.");
          return [];
        }
        // Only ever set once. A later batch echoing a different person means
        // the campaign changed under us, not that this run should switch.
        const chosen = data.recipient as ApiRecipient | null | undefined;
        if (!recipientRef.current && chosen?.personId) {
          recipientRef.current = chosen.personId;
          setRecipientLabel(chosen.label ?? null);
        }
        return (data.drafts as ApiDraft[]).map(toEmail);
      } catch {
        setError("Could not reach the agent.");
        return [];
      } finally {
        setPending(null);
      }
    },
    [buildTranscript, campaignId],
  );

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread]);

  const say = useCallback((m: Message) => setThread((t) => [...t, m]), []);

  /** One remark per swipe, and each observation only ever fires once. */
  const observe = useCallback(
    (nextKept: SwipeEmail[], nextPassed: SwipeEmail[]) => {
      const candidates: { id: string; text: string }[] = [];
      const add = (id: string, text: string) => {
        if (!said[id]) candidates.push({ id, text });
      };

      if (nextKept.length >= 2) {
        for (const dim of ["opener", "tone", "close"] as AttrKey[]) {
          const k = dominant(nextKept, dim);
          if (k && k.n >= 2 && k.share >= 0.5) {
            add(
              `k-${dim}-${k.value}`,
              `${k.n} of the ${nextKept.length} you've kept ${verbFor(dim)}${PHRASE[dim][k.value]}. I'll write that way.`,
            );
          }
        }
        const avg = Math.round(
          nextKept.reduce((s, e) => s + e.words, 0) / nextKept.length,
        );
        if (nextKept.length >= 3 && avg <= 50) {
          add(
            "k-short",
            `Everything you've kept is short: ${avg} words on average.`,
          );
        }
      }

      for (const dim of [
        "opener",
        "greeting",
        "signoff",
        "tone",
      ] as AttrKey[]) {
        const p = dominant(nextPassed, dim);
        if (!p || p.n < 2) continue;
        if (nextKept.some((e) => e.attrs[dim] === p.value)) continue;
        add(
          `p-${dim}-${p.value}`,
          `You've passed on all ${p.n} that ${verbFor(dim)}${PHRASE[dim][p.value]}. Dropping those.`,
        );
      }

      if (!candidates.length) return null;
      setSaid((s) => ({ ...s, [candidates[0].id]: true }));
      return candidates[0].text;
    },
    [said],
  );

  /**
   * Top-up. Runs as an effect rather than inside commit() so the transcript it
   * sends includes the swipe that triggered it — calling it from the commit
   * callback would close over state React had not yet applied.
   *
   * Fires at 1 card remaining rather than 0, so the next batch is usually
   * warm by the time it is reached.
   */
  useEffect(() => {
    if (!opened || pending || stall || error || finished) return;
    if (queue.length > 1) return;
    if (judgedEmails.length === 0 || judgedEmails.length >= MAX_JUDGED) return;
    if (converged(verdicts)) return;

    // Both the remark and the fetch happen inside the async body, so nothing
    // sets state synchronously during the effect.
    void (async () => {
      const r = rolling(verdicts);
      say({
        who: "agent",
        applied: true,
        text: `Keeping ${r.kept} of the last ${r.of}, not ${Math.round(TARGET_RATE * 100)}% yet. Writing more, closer to what you've kept.`,
      });
      const more = await fetchBatch("rewriting", REFILL);
      if (more.length) setQueue((q) => [...q, ...more]);
    })();
    // `say` and `fetchBatch` are stable enough via useCallback; queue.length is
    // the trigger.
  }, [
    opened,
    queue.length,
    judgedEmails.length,
    pending,
    stall,
    error,
    finished,
    verdicts,
    fetchBatch,
    say,
  ]);

  /**
   * The point of the whole run: turn it into a skill the composer applies to
   * every future email. Without this the run ends by showing the attribute
   * derived fallback and saving nothing at all.
   *
   * Guarded by a ref rather than by `skill`, because the request is in flight
   * for ~10s and the effect re-runs on every render in that window.
   */
  useEffect(() => {
    if (!done || !opened || savedRef.current) return;
    if (judgedEmails.length === 0) return;
    savedRef.current = true;
    void (async () => {
      setSkillState("saving");
      try {
        const res = await fetch("/api/email-skills/swipe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "complete",
            transcript: buildTranscript(),
            campaignId,
            recipientPersonId: recipientRef.current,
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.instructions) {
          setSkillState("failed");
          return;
        }
        setSkill({ instructions: data.instructions, summary: data.summary });
        setSkillState("idle");
      } catch {
        setSkillState("failed");
      }
    })();
  }, [done, opened, judgedEmails.length, buildTranscript, campaignId]);

  // Opening batch. Fires once; StrictMode double-invokes effects in dev and a
  // second cold-start call is a wasted Opus request, not just a slow one.
  useEffect(() => {
    if (openingRef.current) return;
    openingRef.current = true;
    void (async () => {
      const first = await fetchBatch("opening", FIRST_BATCH);
      if (first.length) {
        setQueue(first);
        say({
          who: "agent",
          text: `I've written ${first.length} to start, deliberately different from each other. Here's the first: keep it if it sounds like you, or just tell me what's off and I'll rewrite them.`,
        });
      }
      setOpened(true);
    })();
  }, [fetchBatch, say]);

  const commit = useCallback(
    (liked: boolean) => {
      if (busy.current || done || stall || !queue.length) return;
      busy.current = true;
      setHelpOpen(false);
      setLeaving(liked ? "right" : "left");

      const card = queue[0];
      const nextVerdicts = [...verdicts, { id: card.id, liked }];
      const nextJudged = [...judgedEmails, card];
      const nextKept = nextJudged.filter((_, i) => nextVerdicts[i].liked);
      const nextPassed = nextJudged.filter((_, i) => !nextVerdicts[i].liked);

      const remark = observe(nextKept, nextPassed);
      if (remark) say({ who: "agent", text: remark });

      window.setTimeout(() => {
        const rest = queue.slice(1);
        const nowConverged = converged(nextVerdicts);

        // Top up rather than stop: the run ends on the acceptance rate, so a
        // short queue just means write more. Fired at 1 remaining rather than
        // 0 so the next batch is usually warm by the time it is reached.

        setVerdicts(nextVerdicts);
        setJudgedEmails(nextJudged);
        setQueue(rest);
        setLeaving(null);

        // Stall checks. Re-arm rather than re-fire: the streak is still long
        // right after the prompt is answered.
        if (!nowConverged) {
          const s = streak(nextVerdicts);
          if (
            s >= STALL_STREAK &&
            nextJudged.length - stallAt >= STALL_STREAK
          ) {
            setStall({ reason: "streak", n: s });
            setStallAt(nextJudged.length);
          } else if (nextJudged.length >= turnCheck) {
            setStall({ reason: "turns", n: nextJudged.length });
            setStallAt(nextJudged.length);
            setTurnCheck((t) => t + STALL_TURNS);
          }
        }

        busy.current = false;
      }, 300);
    },
    [
      done,
      judgedEmails,
      observe,
      queue,
      say,
      stall,
      stallAt,
      turnCheck,
      verdicts,
    ],
  );

  /**
   * Anything typed is answered by rewriting, not by filtering. The whole queue
   * is replaced — including the draft on screen — because "focus it on a 15
   * minute discovery call" cannot be satisfied by removing cards, only by
   * writing new ones.
   */
  const runInstruction = useCallback(
    async (text: string) => {
      const fresh = await fetchBatch(
        "rewriting",
        Math.max(queue.length, 3),
        text,
      );
      if (!fresh.length) {
        say({
          who: "agent",
          text: "I couldn't rewrite them just then. Send that again?",
        });
        return;
      }
      setQueue(fresh);
      say({
        who: "agent",
        applied: true,
        text: `Rewritten. This one and the ${fresh.length - 1} behind it now follow that.`,
      });
    },
    [fetchBatch, queue.length, say],
  );

  const send = useCallback(() => {
    const value = draft.trim();
    if (!value || pending) return;
    say({ who: "you", text: value });
    setDraft("");
    void runInstruction(value);
  }, [draft, pending, runInstruction, say]);

  // ── Selection → anchored comment ──────────────────────────────────────────
  useEffect(() => {
    const onUp = () => {
      window.setTimeout(() => {
        const s = window.getSelection();
        if (!s || s.isCollapsed) {
          setSel(null);
          return;
        }
        const text = s.toString().trim();
        const node = s.anchorNode;
        const host =
          node instanceof Element ? node : (node?.parentElement ?? null);
        if (!text || !host?.closest("[data-swipe-body]")) {
          setSel(null);
          return;
        }
        const rect = s.getRangeAt(0).getBoundingClientRect();
        setSel({ text, x: rect.left + rect.width / 2, y: rect.top - 6 });
        setSelNote(null);
      }, 0);
    };
    document.addEventListener("pointerup", onUp);
    return () => document.removeEventListener("pointerup", onUp);
  }, []);

  const addComment = useCallback(() => {
    if (!sel || !selNote?.trim() || !queue.length) return;
    const card = queue[0];
    setMarks((m) => ({
      ...m,
      [card.id]: [
        ...(m[card.id] ?? []),
        { text: sel.text, note: selNote.trim() },
      ],
    }));
    say({ who: "you", text: `“${sel.text}”: ${selNote.trim()}` });
    // A phrase comment is the strongest signal available — they pointed at the
    // exact words — so it is sent as one instruction quoting them.
    void runInstruction(`About "${sel.text}": ${selNote.trim()}`);
    setSel(null);
    setSelNote(null);
    window.getSelection()?.removeAllRanges();
  }, [queue, runInstruction, say, sel, selNote]);

  // ── Keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (stall) {
        if (e.key === "Escape") setStall(null);
        return;
      }
      if (e.key === "Escape") {
        setHelpOpen(false);
        setSel(null);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "TEXTAREA" || t?.tagName === "INPUT") return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        commit(false);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        commit(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [commit, stall]);

  if (done) {
    return (
      <Result
        converged={converged(verdicts)}
        roll={roll}
        judged={judgedEmails.length}
        kept={kept}
        passed={passed}
        comments={thread.filter((m) => m.who === "you").map((m) => m.text)}
        skill={skill}
        skillState={skillState}
      />
    );
  }

  const card: SwipeEmail | undefined = queue[0];
  const behind = queue.slice(1, 3);
  const tallest = queue.length
    ? queue.reduce((a, b) => (b.body.length > a.body.length ? b : a), queue[0])
    : undefined;

  return (
    <>
      {/* Deck-level states. Shown in place of the cards rather than behind
          them: a stale draft under a spinner invites judging the old one. */}
      <div
        className={cn(
          "grid overflow-hidden rounded-xl border lg:grid-cols-[minmax(0,1fr)_400px]",
          BORDER_STRONG,
        )}
      >
        {/* Deck */}
        <div className={PANE_DECK}>
          {pending || !card ? (
            <DeckState
              mode={pending ?? (error ? "error" : "opening")}
              error={error}
              onRetry={() => {
                setError(null);
                void (async () => {
                  const more = await fetchBatch(
                    judgedEmails.length ? "rewriting" : "opening",
                    judgedEmails.length ? REFILL : FIRST_BATCH,
                  );
                  if (more.length) setQueue((q) => [...q, ...more]);
                })();
              }}
            />
          ) : (
            <>
              <Progress
                index={judgedEmails.length + 1}
                roll={roll}
                judged={judgedEmails.length}
                helpOpen={helpOpen}
                onToggleHelp={() => setHelpOpen((v) => !v)}
              />

              <div className="mt-5 grid">
                {/* Hidden sizer pins the deck to the tallest draft, so it doesn't
                resize under you when a long email follows a short one. */}
                {tallest && (
                  <Card
                    email={tallest}
                    marks={[]}
                    to={recipientLabel}
                    className="invisible"
                    aria-hidden
                  />
                )}
                {behind
                  .slice()
                  .reverse()
                  .map((e, i) => (
                    <Card
                      key={e.id}
                      email={e}
                      marks={[]}
                      to={recipientLabel}
                      aria-hidden
                      className={
                        behind.length - i === 1
                          ? "z-[1] scale-[0.965] translate-y-3"
                          : "z-0 scale-[0.93] translate-y-6"
                      }
                    />
                  ))}
                <Card
                  // Without a key React reuses this node for the incoming
                  // draft, so it inherits the outgoing card's transform and
                  // slides back in from off-screen carrying the NEW content.
                  // That is what made the swipe feel wrong.
                  key={card.id}
                  email={card}
                  marks={marks[card.id] ?? []}
                  to={recipientLabel}
                  className={cn(
                    // transition-all, not transition-transform: the opacity in
                    // the leaving classes was never animated, so the card
                    // vanished at full opacity mid-flight.
                    "z-[2] transition-all duration-300 ease-out",
                    leaving === "right" &&
                      "translate-x-[125%] rotate-[11deg] opacity-0",
                    leaving === "left" &&
                      "-translate-x-[125%] -rotate-[11deg] opacity-0",
                  )}
                />
              </div>

              <div className="mt-5 flex gap-2.5">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => commit(false)}
                >
                  Not me
                </Button>
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => commit(true)}
                >
                  Sounds like me
                </Button>
              </div>
              <p className="text-muted-foreground mt-3 text-center text-[0.75rem]">
                Use ← → , or select any phrase to comment on it.
              </p>
            </>
          )}
        </div>

        {/* Conversation */}
        <aside
          className={cn(
            "bg-background flex min-h-0 flex-col border-t lg:border-t-0 lg:border-l",
            BORDER_STRONG,
          )}
        >
          <div className="border-border text-muted-foreground flex justify-between border-b px-5 py-[15px] text-[0.8125rem]">
            <span>What it&apos;s picking up</span>
            <span>{judgedEmails.length} judged</span>
          </div>
          <div
            ref={threadRef}
            className={cn(
              "flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-5",
              // Before the first swipe there is one sentence in a 550px column,
              // which reads as a broken panel rather than an empty one. Centre
              // the placeholder and give it something true to say.
              thread.length === 0 && "justify-center",
            )}
          >
            {thread.length === 0 ? (
              <div className="flex flex-col gap-3">
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Nothing learned yet. As you keep and pass drafts I&apos;ll say
                  what I&apos;m picking up, here.
                </p>
                <div className="flex flex-col gap-1.5">
                  <p className="text-muted-foreground/70 text-[0.6875rem] tracking-wide uppercase">
                    What I&apos;m varying
                  </p>
                  {[
                    ["Opener", "signal · problem · number · story"],
                    ["Tone", "blunt · warm · plain · formal"],
                    ["Close", "question · ask for a call · statement"],
                    ["Greeting & sign-off", "and how long it runs"],
                  ].map(([k, v]) => (
                    <p key={k} className="text-[0.6875rem] leading-snug">
                      <span className="font-medium">{k}</span>{" "}
                      <span className="text-muted-foreground">{v}</span>
                    </p>
                  ))}
                </div>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Type below any time, “never open with a compliment”,
                  “shorter”, and it changes what you see next.
                </p>
              </div>
            ) : (
              thread.map((m, i) => (
                <p
                  key={i}
                  className={cn(
                    "text-[0.875rem] leading-relaxed",
                    m.who === "you" &&
                      "border-border bg-card self-end rounded-md border px-3 py-2",
                    m.applied && "border-primary border-l-2 pl-2.5",
                  )}
                >
                  {m.text}
                </p>
              ))
            )}
          </div>
          <div className="border-border flex flex-col gap-2.5 border-t px-5 py-4">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="Anything the swipes miss…"
              className="min-h-[52px] resize-none text-[0.8125rem]"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground text-[0.6875rem]">
                Enter to send
              </span>
              <Button size="sm" onClick={send} disabled={!draft.trim()}>
                Send
              </Button>
            </div>
          </div>
        </aside>
      </div>

      {/* Selection comment */}
      {sel && selNote === null && (
        <button
          type="button"
          className="bg-foreground text-background fixed z-40 -translate-x-1/2 -translate-y-full rounded-md px-3 py-1.5 text-xs font-medium shadow-lg"
          style={{ left: sel.x, top: sel.y }}
          onClick={() => setSelNote("")}
        >
          Comment on this
        </button>
      )}
      {sel && selNote !== null && (
        <div
          role="dialog"
          aria-label="Comment on selected text"
          className={cn(
            "bg-card fixed z-40 flex w-64 -translate-x-1/2 -translate-y-full flex-col gap-2 rounded-lg border p-3 shadow-xl",
            BORDER_STRONG,
          )}
          style={{ left: sel.x, top: sel.y }}
        >
          <p className="border-primary/60 border-l-2 pl-2 text-xs leading-snug">
            “{sel.text.length > 90 ? `${sel.text.slice(0, 90)}…` : sel.text}”
          </p>
          <Textarea
            autoFocus
            value={selNote}
            onChange={(e) => setSelNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                addComment();
              }
            }}
            rows={2}
            placeholder="What's wrong with it?"
            className="min-h-[58px] resize-none text-[0.8125rem]"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSel(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={addComment} disabled={!selNote.trim()}>
              Add
            </Button>
          </div>
        </div>
      )}

      {stall && (
        <StallPrompt
          stall={stall}
          onSend={(text) => {
            say({ who: "you", text });
            setStall(null);
            void runInstruction(text);
          }}
          onSkip={() => setStall(null)}
          onFinish={() => {
            setStall(null);
            setFinished(true);
          }}
        />
      )}
    </>
  );
}

/**
 * What the deck column shows when there is no card: the model writing, or the
 * failure that stopped it. Kept inside the column so the conversation stays
 * visible and readable beside it.
 */
function DeckState({
  mode,
  error,
  onRetry,
}: {
  mode: "opening" | "rewriting" | "error";
  error: string | null;
  onRetry: () => void;
}) {
  if (mode === "error") {
    return (
      <div
        role="alert"
        className="flex min-h-[420px] flex-col items-start justify-center gap-3"
      >
        <p className="text-sm font-medium">That didn&apos;t go through</p>
        <p className="text-muted-foreground max-w-[52ch] text-sm">
          {error ?? "The agent could not write the next drafts."}
        </p>
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[420px] flex-col items-start justify-center gap-4"
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="border-muted-foreground/30 border-t-foreground size-4 animate-spin rounded-full border-2"
        />
        <p className="text-sm font-medium">
          {mode === "opening"
            ? "Writing your first drafts"
            : "Rewriting to match what you said"}
        </p>
      </div>
      <p className="text-muted-foreground max-w-[52ch] text-sm leading-relaxed">
        {mode === "opening"
          ? "Six emails, deliberately different from each other, so that keeping one tells me something."
          : "Applying it to this draft and the ones behind it. Takes a few seconds."}
      </p>
      {/* Skeleton at the measure the real card uses, so the swap doesn't jump. */}
      <div className="flex w-full max-w-[64ch] flex-col gap-2.5 pt-1">
        {[92, 78, 96, 61, 84, 44].map((w, i) => (
          <span
            key={i}
            className="bg-muted h-3 animate-pulse rounded"
            style={{ width: `${w}%`, animationDelay: `${i * 90}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

function Progress({
  index,
  roll,
  judged,
  helpOpen,
  onToggleHelp,
}: {
  index: number;
  roll: { kept: number; of: number };
  judged: number;
  helpOpen: boolean;
  onToggleHelp: () => void;
}) {
  const need = needed();
  const line =
    judged < MIN_JUDGED
      ? `Ends when you keep ${need} of any ${WINDOW} in a row, ${MIN_JUDGED - judged} more before that can happen.`
      : roll.of < WINDOW
        ? `Ends when you keep ${need} of any ${WINDOW} in a row.`
        : roll.kept >= need
          ? `That's it: ${roll.kept} of ${WINDOW}.`
          : need - roll.kept === 1
            ? `Keeping ${roll.kept} of the last ${WINDOW}. One more and it's done.`
            : `Keeping ${roll.kept} of the last ${WINDOW}. ${need - roll.kept} more to go.`;

  const pct = Math.min(
    100,
    Math.round((roll.kept / WINDOW / TARGET_RATE) * 100),
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs tabular-nums">
          Email {index}
        </span>
        <div className="flex items-center gap-2.5">
          <span className="text-muted-foreground text-xs tabular-nums">
            {roll.kept} of last {roll.of} kept
          </span>
          <div className="relative flex">
            <button
              type="button"
              aria-expanded={helpOpen}
              aria-label="How this works"
              onClick={onToggleHelp}
              className="border-muted-foreground/40 text-muted-foreground hover:text-foreground grid size-[18px] place-items-center rounded-full border text-[0.6875rem] font-medium"
            >
              ?
            </button>
            {helpOpen && (
              <div
                role="tooltip"
                className={cn(
                  "bg-card absolute top-[calc(100%+7px)] right-0 z-20 flex w-60 flex-col gap-2 rounded-md border p-3 shadow-lg",
                  BORDER_STRONG,
                )}
              >
                <p className="text-muted-foreground text-xs leading-snug">
                  <b className="text-foreground font-medium">Keep</b> the ones
                  that sound like something you&apos;d have written.{" "}
                  <b className="text-foreground font-medium">Pass</b> on the
                  rest.
                </p>
                <p className="text-muted-foreground text-xs leading-snug">
                  Say anything a swipe can&apos;t, like “never open with a
                  compliment”, and it rewrites what&apos;s still to come.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="bg-muted h-[3px] overflow-hidden rounded-full">
        <div
          className="bg-primary h-full rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-muted-foreground text-[0.6875rem] leading-snug">
        {line}
      </p>
    </div>
  );
}

function Card({
  email,
  marks,
  to,
  className,
  ...rest
}: {
  email: SwipeEmail;
  marks: Mark[];
  /** The run's real prospect. Null when there was nobody to write about. */
  to?: string | null;
} & React.HTMLAttributes<HTMLElement>) {
  // Escape happens via React; marks are applied by splitting on the phrase so a
  // selection containing regex metacharacters can't break the render.
  const segments: React.ReactNode[] = [];
  let remaining = email.body;
  let key = 0;
  while (remaining.length > 0) {
    const hit = marks
      .map((m) => ({ m, at: remaining.indexOf(m.text) }))
      .filter((h) => h.at !== -1)
      .sort((a, b) => a.at - b.at)[0];
    if (!hit) {
      segments.push(<span key={key++}>{remaining}</span>);
      break;
    }
    if (hit.at > 0)
      segments.push(<span key={key++}>{remaining.slice(0, hit.at)}</span>);
    segments.push(
      <mark
        key={key++}
        title={hit.m.note}
        className="bg-primary/15 border-primary/50 text-foreground cursor-help rounded-sm border-b-2 px-0.5"
      >
        {hit.m.text}
      </mark>,
    );
    remaining = remaining.slice(hit.at + hit.m.text.length);
  }

  return (
    <article
      {...rest}
      className={cn(
        "bg-card col-start-1 row-start-1 flex flex-col overflow-hidden border",
        CARD,
        BORDER_STRONG,
        className,
      )}
    >
      <span className="text-muted-foreground mb-3.5 text-[0.8125rem]">
        To {to ?? "a prospect in this campaign"}
      </span>
      <h2 className="mb-3.5 text-[1.1875rem] leading-[1.35] font-medium tracking-tight text-balance">
        {email.subject}
      </h2>
      <p
        data-swipe-body
        className="max-w-[64ch] flex-1 cursor-text text-[1rem] leading-[1.75] whitespace-pre-wrap select-text"
      >
        {segments}
      </p>
      <p className="border-border text-muted-foreground mt-4 border-t pt-3 text-[0.75rem] tabular-nums">
        {email.words} words · {readSeconds(email.words)} sec read
      </p>
    </article>
  );
}

function StallPrompt({
  stall,
  onSend,
  onSkip,
  onFinish,
}: {
  stall: Stall;
  onSend: (text: string) => void;
  onSkip: () => void;
  onFinish: () => void;
}) {
  const [text, setText] = useState("");
  const head =
    stall.reason === "streak"
      ? `You've passed on the last ${stall.n}.`
      : `${stall.n} emails in and none of this is landing.`;
  const sub =
    stall.reason === "streak"
      ? "I'm missing something. Tell me what's wrong and I'll rewrite the rest, it's faster than swiping through more of the same."
      : "You're keeping some, but not enough for me to trust the pattern. What would make these right?";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-6">
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "bg-card flex w-full max-w-md flex-col gap-3.5 rounded-xl border p-5 shadow-2xl",
          BORDER_STRONG,
        )}
      >
        <h2 className="text-[1.0625rem] leading-snug font-medium tracking-tight text-balance">
          {head}
        </h2>
        <p className="text-muted-foreground text-[0.8125rem] leading-relaxed">
          {sub}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {STALL_QUICK.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() =>
                setText((t) =>
                  t.trim() ? `${t.trim().replace(/\.$/, "")}. ${q}` : q,
                )
              }
              className="border-muted-foreground/30 hover:border-muted-foreground rounded-full border px-3 py-1 text-xs"
            >
              {q}
            </button>
          ))}
        </div>
        <Textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (text.trim()) onSend(text.trim());
            }
          }}
          rows={3}
          placeholder="Or say it in your own words…"
          className="min-h-[74px] resize-none"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={onFinish}
            className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
          >
            Finish with what you have
          </button>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onSkip}>
              Keep swiping
            </Button>
            <Button
              size="sm"
              onClick={() => text.trim() && onSend(text.trim())}
              disabled={!text.trim()}
            >
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Result({
  converged: didConverge,
  roll,
  judged,
  kept,
  passed,
  comments,
  skill,
  skillState,
}: {
  converged: boolean;
  roll: { kept: number; of: number };
  judged: number;
  kept: SwipeEmail[];
  passed: SwipeEmail[];
  comments: string[];
  skill: { instructions: string; summary: string } | null;
  skillState: "idle" | "saving" | "failed";
}) {
  // The model's rules are the deliverable. deriveRules is a local fallback so
  // the run still shows something if the save failed — but it is derived from
  // attribute counts, not from anything the user said, so it must never be
  // presented as the saved skill.
  const rules = skill
    ? skill.instructions.split("\n").filter((l) => l.trim())
    : deriveRules(kept, passed);

  return (
    <div className="max-w-2xl">
      <h1 className="mb-2 text-[1.375rem] font-medium tracking-tight">
        {skillState === "saving"
          ? "Writing your voice…"
          : didConverge
            ? "That's your voice."
            : "Ran out of drafts."}
      </h1>
      {skill?.summary && (
        <p className="mb-4 text-[0.9375rem] leading-relaxed">{skill.summary}</p>
      )}
      <p className="text-muted-foreground mb-6 text-[0.9375rem] leading-relaxed">
        {skill
          ? "Saved. Every cold email the agent writes from now on goes through these rules. "
          : skillState === "saving"
            ? "Turning the run into rules the agent will follow. "
            : skillState === "failed"
              ? "The rules could not be saved, so nothing was written. What's below is a local summary of the run, not your saved voice. "
              : didConverge
                ? `You kept ${roll.kept} of the last ${roll.of}, it's writing emails you'd send. `
                : `It didn't reach ${Math.round(TARGET_RATE * 100)}% before the drafts ran out. `}
        Built from {judged} judgement{judged === 1 ? "" : "s"}
        {comments.length
          ? ` and ${comments.length} comment${comments.length > 1 ? "s" : ""}`
          : ""}
        .
      </p>

      <div className="border-border mb-6 flex gap-6 border-y py-3.5">
        {[
          ["kept", kept.length],
          ["passed", passed.length],
          ["comments", comments.length],
        ].map(([label, n]) => (
          <div key={label as string} className="flex flex-col">
            <span className="text-xl font-medium tabular-nums">{n}</span>
            <span className="text-muted-foreground text-xs">{label}</span>
          </div>
        ))}
      </div>

      {rules.length ? (
        <ul className="mb-6 flex flex-col gap-3">
          {rules.map((r) => (
            <li key={r} className="flex gap-3 text-[0.9375rem] leading-snug">
              <span className="text-success shrink-0">✓</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground mb-6 text-[0.9375rem]">
          Too few kept to draw a pattern from. Run it again and keep at least
          two.
        </p>
      )}

      {comments.length > 0 && (
        <div className="mb-6 flex flex-col gap-2.5">
          {comments.map((c, i) => (
            <p
              key={i}
              className="border-border text-muted-foreground border-l-2 pl-3 text-[0.8125rem] leading-relaxed"
            >
              “{c}”
            </p>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Button onClick={() => window.location.reload()}>Save it</Button>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Start over
        </Button>
      </div>
    </div>
  );
}
