"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { EmailSample, InterviewMove } from "@/lib/types/email-voice";

/**
 * The agent reads the transcript back as prose on every turn, so a choice has
 * to be answered in words. "a" would be a code the model has to decode from
 * position; naming the option keeps the transcript self-describing.
 */
const PREFER_A = "Prefers option A.";
const PREFER_B = "Prefers option B.";
const NO_PREFERENCE = "No strong feeling either way, neither stands out.";
const NO_SAMPLES = "Has no email samples to share.";

interface InterviewMoveViewProps {
  move: InterviewMove;
  /** A request is in flight; every control must be inert until it lands. */
  disabled: boolean;
  onAnswer: (answer: string) => void;
}

/**
 * Renders one interview move. `complete` is deliberately not handled here —
 * the generated profile is a review screen, not another question, and the
 * wizard owns it.
 */
export function InterviewMoveView({
  move,
  disabled,
  onAnswer,
}: InterviewMoveViewProps) {
  switch (move.kind) {
    case "question":
      return (
        <QuestionMove move={move} disabled={disabled} onAnswer={onAnswer} />
      );
    case "compare":
      return (
        <CompareMove move={move} disabled={disabled} onAnswer={onAnswer} />
      );
    case "request_samples":
      return (
        <SamplesMove move={move} disabled={disabled} onAnswer={onAnswer} />
      );
    case "complete":
      return null;
  }
}

/**
 * What the live region announces when a move arrives. Kept next to the
 * renderers so a new move kind can't silently ship without one.
 */
export function describeMove(move: InterviewMove): string {
  switch (move.kind) {
    case "question":
      return `New question: ${move.prompt}`;
    case "compare":
      return `Two emails to compare, differing in ${move.dimension}. Choose the one that sounds more like you.`;
    case "request_samples":
      return move.prompt;
    case "complete":
      return "Your email voice is ready to review.";
  }
}

function MoveCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-border bg-card animate-in fade-in-0 space-y-4 rounded-xl border p-5 duration-200">
      {children}
    </div>
  );
}

function QuestionMove({
  move,
  disabled,
  onAnswer,
}: {
  move: Extract<InterviewMove, { kind: "question" }>;
  disabled: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [value, setValue] = useState("");

  if (move.inputType === "choice" && move.choices && move.choices.length > 0) {
    return (
      <MoveCard>
        <p id="interview-prompt" className="type-large text-foreground">
          {move.prompt}
        </p>
        <div
          role="group"
          aria-labelledby="interview-prompt"
          className="flex flex-wrap gap-2"
        >
          {move.choices.map((choice) => (
            <Button
              key={choice}
              variant="outline"
              size="lg"
              disabled={disabled}
              onClick={() => onAnswer(choice)}
            >
              {choice}
            </Button>
          ))}
        </div>
      </MoveCard>
    );
  }

  const trimmed = value.trim();
  const submit = () => {
    if (disabled || !trimmed) return;
    onAnswer(trimmed);
  };

  return (
    <MoveCard>
      {/* The prompt *is* the label — no second, smaller restatement of it. */}
      <label
        htmlFor="interview-answer"
        className="type-large text-foreground block"
      >
        {move.prompt}
      </label>
      <Textarea
        id="interview-answer"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Answers are a sentence or two, so Enter should send. Shift+Enter
          // stays available for the occasional multi-line answer.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={3}
        autoFocus
        disabled={disabled}
        placeholder="Answer in your own words. A sentence is plenty."
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          Enter to send, Shift+Enter for a new line.
        </p>
        <Button disabled={disabled || !trimmed} onClick={submit}>
          Send answer
        </Button>
      </div>
    </MoveCard>
  );
}

function CompareMove({
  move,
  disabled,
  onAnswer,
}: {
  move: Extract<InterviewMove, { kind: "compare" }>;
  disabled: boolean;
  onAnswer: (answer: string) => void;
}) {
  return (
    <MoveCard>
      <div className="space-y-1">
        <p className="type-large text-foreground">
          Which of these sounds more like you?
        </p>
        <p className="text-muted-foreground text-sm">
          Same offer, same prospect. They differ in one thing:{" "}
          <span className="text-foreground font-medium">{move.dimension}</span>.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <SampleCard
          label="Option A"
          sample={move.a}
          disabled={disabled}
          onPick={() => onAnswer(PREFER_A)}
        />
        <SampleCard
          label="Option B"
          sample={move.b}
          disabled={disabled}
          onPick={() => onAnswer(PREFER_B)}
        />
      </div>

      <div className="flex justify-center">
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onAnswer(NO_PREFERENCE)}
        >
          Neither, no strong feeling
        </Button>
      </div>
    </MoveCard>
  );
}

function SampleCard({
  label,
  sample,
  disabled,
  onPick,
}: {
  label: string;
  sample: EmailSample;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <div
      // Grouped and labelled so the two cards are distinguishable to a screen
      // reader — otherwise both "Prefer this" buttons have the same name and
      // the email bodies are unassociated prose.
      role="group"
      aria-label={label}
      className="border-border bg-background flex flex-col overflow-hidden rounded-lg border"
    >
      {/* Subject sits in its own tinted band so it reads as a subject line and
          not as the first sentence of the body. */}
      <div className="border-border bg-muted/40 space-y-0.5 border-b px-4 py-3">
        <p className="text-muted-foreground text-[10px] font-semibold tracking-widest uppercase">
          {label} · subject
        </p>
        <p className="text-foreground text-sm font-medium">{sample.subject}</p>
      </div>

      <div className="flex-1 px-4 py-4">
        {/* Real line breaks and a ~55ch measure: the whole reason this is a
            wizard and not a chat window is that the copy has to be readable. */}
        <p className="text-foreground/90 max-w-[55ch] text-[13px] leading-relaxed whitespace-pre-wrap">
          {sample.body}
        </p>
      </div>

      <div className="border-border border-t p-3">
        <Button
          variant="outline"
          className="w-full"
          disabled={disabled}
          onClick={onPick}
          aria-label={`Prefer ${label}: ${sample.subject}`}
        >
          Prefer this
        </Button>
      </div>
    </div>
  );
}

function SamplesMove({
  move,
  disabled,
  onAnswer,
}: {
  move: Extract<InterviewMove, { kind: "request_samples" }>;
  disabled: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();

  return (
    <MoveCard>
      <label
        htmlFor="interview-samples"
        className="type-large text-foreground block"
      >
        {move.prompt}
      </label>
      <Textarea
        id="interview-samples"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={10}
        disabled={disabled}
        // The route rejects answers over 20k chars. Capping here stops a long
        // paste from coming back as a raw validation error the user can't act on.
        maxLength={20_000}
        placeholder="Paste one or more emails you have actually sent. Subject lines help too."
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Most people have nothing to hand. Skipping is a normal path, so it is
            stated as one rather than buried as a way out. */}
        <p className="text-muted-foreground text-xs">
          Nothing to paste? Skip it. The questions on their own are enough.
        </p>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => onAnswer(NO_SAMPLES)}
          >
            Skip this step
          </Button>
          <Button
            disabled={disabled || !trimmed}
            onClick={() => onAnswer(trimmed)}
          >
            Use these samples
          </Button>
        </div>
      </div>
    </MoveCard>
  );
}
