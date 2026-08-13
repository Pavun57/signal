"use client";

import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";

import { apiFetch } from "@/lib/api-fetch";

/**
 * Chat transport for /api/chat. Auth rides the Supabase session cookie, so
 * there are no headers to attach; `fetch` is routed through `apiFetch` so a
 * dead session surfaces as "Unauthorized" instead of the SDK trying to parse
 * an HTML redirect target as a chat stream.
 */
export function createChatTransport() {
  return new DefaultChatTransport<UIMessage>({
    api: "/api/chat",
    fetch: (input, init) => apiFetch(String(input), init ?? {}),
  });
}
