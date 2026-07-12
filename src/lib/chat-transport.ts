"use client";

import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";

import { getSessionToken } from "@/lib/api-fetch";

/**
 * Chat transport that mints a fresh Clerk session token for every request, for
 * the same reason `apiFetch` does — see the note there. The chat is the most
 * visible victim of a stale tab because a dead POST kills the whole stream.
 */
export function createChatTransport() {
  return new DefaultChatTransport<UIMessage>({
    api: "/api/chat",
    headers: async (): Promise<Record<string, string>> => {
      const token = await getSessionToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
  });
}
