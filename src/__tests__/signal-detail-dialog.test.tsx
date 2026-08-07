import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SignalDetailDialog } from "@/components/signals/signal-detail-dialog";
import type { Signal } from "@/lib/types/signal";

afterEach(cleanup);

function signal(over: Partial<Signal> = {}): Signal {
  return {
    id: "sig_1",
    name: "Hiring for GTM roles",
    description: "Company is hiring GTM",
    long_description: "Watch the careers page for GTM openings.",
    category: "hiring",
    icon: null,
    execution_type: "exa_search",
    tool_key: null,
    config: {},
    is_builtin: false,
    is_public: true,
    created_by: "prof_other",
    created_at: "",
    updated_at: "",
    ...over,
  } as Signal;
}

describe("<SignalDetailDialog> edit gating", () => {
  it("offers Edit only when the page supplies an onEdit handler", () => {
    // The page passes onEdit only for the user's OWN signals: Edit
    // interpolates the signal's stored text into an auto-sent agent message
    // and the agent holds send tools, so another tenant's community signal
    // must never take this path (cross-tenant prompt injection).
    render(
      <SignalDetailDialog
        signal={signal()}
        open
        onOpenChange={vi.fn()}
        onEdit={undefined}
        onMakePublic={undefined}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /edit/i }),
    ).not.toBeInTheDocument();
  });

  it("still offers Edit for an owned non-builtin signal", () => {
    render(
      <SignalDetailDialog
        signal={signal({ is_public: false, created_by: "prof_mine" })}
        open
        onOpenChange={vi.fn()}
        onEdit={vi.fn()}
        onMakePublic={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
  });
});
