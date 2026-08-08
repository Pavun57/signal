import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

beforeAll(() => {
  // StatCard's count-up hook reads prefers-reduced-motion; jsdom has no
  // matchMedia. Reduced motion also makes the counter render its final value
  // immediately, which is what the assertions need.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

import { CampaignStats } from "@/components/campaign/campaign-stats";
import type { CampaignCompany, CampaignContact } from "@/lib/types/campaign";

/**
 * The contacted bucket. Bounced and complained sends still left, so they
 * belong in the denominator: excluding them inflated the reply rate and made
 * this card disagree with the dashboard, which was already fixed for this.
 */

const contact = (id: string, outreach: string): CampaignContact =>
  ({
    id,
    outreach_status: outreach,
    enrichment_status: "pending",
  }) as unknown as CampaignContact;

describe("CampaignStats", () => {
  it("counts bounced contacts as contacted and in the reply-rate denominator", () => {
    const contacts = [
      ...Array.from({ length: 7 }, (_, i) => contact(`s${i}`, "sent")),
      contact("b1", "bounced"),
      contact("b2", "bounced"),
      contact("r1", "replied"),
    ];

    render(
      <CampaignStats companies={[] as CampaignCompany[]} contacts={contacts} />,
    );

    // 10 contacted (7 sent + 2 bounced + 1 replied), so the rate is 10%,
    // not 1/8 = 13%.
    expect(screen.getByText("1 of 10 contacted")).toBeInTheDocument();
  });
});
