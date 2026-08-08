import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Markdown } from "@/components/ui/markdown";

/**
 * autoLinkDomains rewrites the raw markdown BEFORE parsing, so it must leave
 * fenced code blocks byte-for-byte alone: a bare domain on a code line used
 * to render as literal "[acme.com](https://acme.com)" inside a command the
 * user might copy.
 */
describe("Markdown domain auto-linking", () => {
  it("links a bare domain in prose", () => {
    render(<Markdown>visit acme.com today</Markdown>);

    const link = screen.getByRole("link", { name: "acme.com" });
    expect(link).toHaveAttribute("href", "https://acme.com");
  });

  it("leaves code blocks untouched", () => {
    const { container } = render(
      <Markdown>{"```\nping acme.com\n```"}</Markdown>,
    );

    expect(container.textContent).toContain("ping acme.com");
    expect(container.textContent).not.toContain("[acme.com]");
    expect(container.querySelector("code a")).toBeNull();
  });
});
