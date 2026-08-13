"use client";

import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";

import { apiFetch, getSessionToken } from "@/lib/api-fetch";

/**
 * Chat transport that mints a fresh Clerk session token for every request, for
 * the same reason `apiFetch` does — see the note there. The chat is the most
 * visible victim of a stale tab because a dead POST kills the whole stream.
 *
 * `fetch` is routed through `apiFetch` too: without it, an unauthenticated
 * POST /api/chat follows Clerk's 307 to /login and the SDK then tries to parse
 * the HTML login page as a chat stream instead of surfacing "Unauthorized".
 */
export function createChatTransport() {
  return new DefaultChatTransport<UIMessage>({
    api: "/api/chat",
    fetch: (input, init) => apiFetch(String(input), init ?? {}),
    headers: async (): Promise<Record<string, string>> => {
      const token = await getSessionToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
  });
}
