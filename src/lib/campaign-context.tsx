"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Nonce-keyed so that queueing the same text twice is two sends: the voice
 * deck legitimately asks "write the next batch" many times in one session,
 * and the panel keys its consume effect on the nonce rather than the string.
 */
export interface PendingPrompt {
  nonce: number;
  text: string;
}

interface CampaignContextValue {
  activeCampaignId: string | null;
  setActiveCampaignId: (id: string | null) => void;
  agentOpen: boolean;
  setAgentOpen: (open: boolean) => void;
  pendingPrompt: PendingPrompt | null;
  consumePendingPrompt: () => string | null;
  openAgentWith: (prefill?: string) => void;
}

const CampaignContext = createContext<CampaignContextValue>({
  activeCampaignId: null,
  setActiveCampaignId: () => {},
  agentOpen: false,
  setAgentOpen: () => {},
  pendingPrompt: null,
  consumePendingPrompt: () => null,
  openAgentWith: () => {},
});

let promptNonce = 0;

export function CampaignProvider({ children }: { children: ReactNode }) {
  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(
    null,
  );

  const consumePendingPrompt = useCallback(() => {
    const value = pendingPrompt;
    if (value !== null) setPendingPrompt(null);
    return value?.text ?? null;
  }, [pendingPrompt]);

  const openAgentWith = useCallback((prefill?: string) => {
    if (prefill) {
      promptNonce += 1;
      setPendingPrompt({ nonce: promptNonce, text: prefill });
    }
    setAgentOpen(true);
  }, []);

  const value = useMemo<CampaignContextValue>(
    () => ({
      activeCampaignId,
      setActiveCampaignId,
      agentOpen,
      setAgentOpen,
      pendingPrompt,
      consumePendingPrompt,
      openAgentWith,
    }),
    [
      activeCampaignId,
      agentOpen,
      pendingPrompt,
      consumePendingPrompt,
      openAgentWith,
    ],
  );

  return <CampaignContext value={value}>{children}</CampaignContext>;
}

export function useCampaign() {
  return useContext(CampaignContext);
}
