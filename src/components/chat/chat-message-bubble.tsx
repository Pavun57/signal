"use client";

import { memo } from "react";
import dynamic from "next/dynamic";

import type { UIMessage } from "ai";
import { isToolUIPart, getToolName } from "ai";
import { Bot, User } from "lucide-react";

import {
  INLINE_TOOLS,
  ToolCallCard,
  ToolCallGroup,
  type ToolCallCardProps,
} from "./tool-call-card";

/** Runs of at least this many same-tool calls collapse into one group row. */
const MIN_RUN_TO_COLLAPSE = 3;

const Markdown = dynamic(
  () => import("@/components/ui/markdown").then((m) => m.Markdown),
  {
    ssr: false,
    loading: () => (
      <div className="bg-muted-foreground/10 h-4 w-32 animate-pulse rounded" />
    ),
  },
);

interface ChatMessageBubbleProps {
  message: UIMessage;
  isStreaming?: boolean;
}

function StreamingMarkdown({ text }: { text: string }) {
  // During streaming, render markdown with a subtle fade-in on the container.
  // We can't animate per-sentence because markdown needs the full string.
  return (
    <div className="animate-in fade-in-0 duration-300">
      <Markdown>{text}</Markdown>
    </div>
  );
}

export const ChatMessageBubble = memo(
  function ChatMessageBubble({ message, isStreaming }: ChatMessageBubbleProps) {
    const isUser = message.role === "user";

    if (isUser) {
      const textContent = message.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");

      return (
        <div className="flex justify-end gap-3 animate-in fade-in-0 duration-500">
          <div className="bg-primary text-primary-foreground max-w-[80%] rounded-2xl rounded-br-md px-4 py-2.5 text-sm">
            {textContent && (
              <p className="whitespace-pre-wrap">{textContent}</p>
            )}
          </div>
          <div className="bg-primary/10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
            <User className="text-primary h-4 w-4" />
          </div>
        </div>
      );
    }

    // Render assistant parts in order — interleave text and tool calls
    // so multi-step responses show naturally (text → tool → text → tool → text)
    const parts = message.parts;
    const lastTextIndex = parts.reduce(
      (last, p, i) => (p.type === "text" ? i : last),
      -1,
    );

    const liveViewByToolCall = new Map<string, string>();
    for (const p of parts) {
      if (
        p.type === "data-browserbaseLiveView" &&
        typeof (p as { id?: unknown }).id === "string"
      ) {
        const d = (p as { data?: { url?: unknown } }).data;
        if (d && typeof d.url === "string") {
          liveViewByToolCall.set((p as { id: string }).id, d.url);
        }
      }
    }

    return (
      <div className="flex gap-3 animate-in fade-in-0 duration-500">
        <div className="bg-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
          <Bot className="text-muted-foreground h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          {(() => {
            const toCardProps = (
              part: Extract<(typeof parts)[number], { toolCallId: string }>,
            ): ToolCallCardProps & { toolCallId: string } => ({
              toolCallId: part.toolCallId,
              toolName: getToolName(part),
              state: part.state,
              input: "input" in part ? part.input : undefined,
              output: "output" in part ? part.output : undefined,
              errorText:
                "errorText" in part ? (part.errorText as string) : undefined,
              liveViewUrl: liveViewByToolCall.get(part.toolCallId),
            });

            const rendered: React.ReactNode[] = [];
            let i = 0;
            while (i < parts.length) {
              const part = parts[i];

              if (isToolUIPart(part) && !INLINE_TOOLS.has(getToolName(part))) {
                // Collect the run of consecutive same-tool calls. step-start
                // markers between agent steps are invisible in the transcript,
                // so a run may continue across them.
                const name = getToolName(part);
                const run = [part];
                let j = i + 1;
                while (j < parts.length) {
                  const next = parts[j];
                  if (next.type === "step-start") {
                    j++;
                    continue;
                  }
                  if (isToolUIPart(next) && getToolName(next) === name) {
                    run.push(next);
                    j++;
                    continue;
                  }
                  break;
                }

                if (run.length >= MIN_RUN_TO_COLLAPSE) {
                  rendered.push(
                    <ToolCallGroup
                      key={part.toolCallId}
                      calls={run.map(toCardProps)}
                    />,
                  );
                  i = j;
                  continue;
                }

                const { toolCallId, ...cardProps } = toCardProps(part);
                rendered.push(<ToolCallCard key={toolCallId} {...cardProps} />);
                i++;
                continue;
              }

              if (isToolUIPart(part)) {
                const { toolCallId, ...cardProps } = toCardProps(part);
                rendered.push(<ToolCallCard key={toolCallId} {...cardProps} />);
                i++;
                continue;
              }

              if (part.type === "text" && part.text) {
                const isLastText = i === lastTextIndex;
                const isActivelyStreaming = isStreaming && isLastText;

                rendered.push(
                  <div
                    key={`text-${i}`}
                    className="bg-muted/60 my-1 rounded-2xl rounded-bl-md px-4 py-2.5 text-sm"
                  >
                    {isActivelyStreaming ? (
                      <StreamingMarkdown text={part.text} />
                    ) : (
                      <Markdown>{part.text}</Markdown>
                    )}
                  </div>,
                );
              }

              // Other part types (step-start, reasoning, etc.) render nothing.
              i++;
            }
            return rendered;
          })()}
        </div>
      </div>
    );
  },
  (prev, next) => {
    // During streaming, always re-render the latest assistant message
    if (next.isStreaming) return false;
    // Otherwise only re-render if content changed
    return prev.message === next.message;
  },
);
