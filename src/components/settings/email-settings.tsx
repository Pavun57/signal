"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/settings/settings-section";
import { apiFetch } from "@/lib/api-fetch";

// 20s x 15 attempts is five minutes of watching, then we stop and hand the
// user a manual "Check now" — an unbounded poll would hammer IMAP forever.
const POLL_MS = 20_000;
const MAX_POLLS = 15;

type TestStatus = "idle" | "waiting" | "replied" | "bounced";

// `from`/`subject` are only known when this tab was the one that detected the
// reply; a page load only recovers the stored timestamp.
type TestReply = {
  from?: string | null;
  subject?: string | null;
  at: string;
  snippet?: string | null;
};

function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

// "" is the "no window" sentinel in the hour selects.
const HOUR_ITEMS = [
  { value: "", label: "No window" },
  ...Array.from({ length: 24 }, (_, h) => ({
    value: String(h),
    label: `${String(h).padStart(2, "0")}:00`,
  })),
];

const WINDOW_SCOPE_ITEMS = [
  { value: "sender", label: "My timezone" },
  { value: "recipient", label: "Each recipient's timezone" },
];

const TIMEZONE_ITEMS = Intl.supportedValuesOf("timeZone").map((tz) => ({
  value: tz,
  label: tz,
}));

export function EmailSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const [gmailAddress, setGmailAddress] = useState<string | null>(null);
  const [warmupDay, setWarmupDay] = useState<number | null>(null);
  const [effectiveLimit, setEffectiveLimit] = useState<number | null>(null);
  const [ramping, setRamping] = useState(false);

  const [addressInput, setAddressInput] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [dailyLimit, setDailyLimit] = useState("30");
  const [sendingPaused, setSendingPaused] = useState(false);
  const [pauseToggling, setPauseToggling] = useState(false);

  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [windowTimezone, setWindowTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [windowScope, setWindowScope] = useState("sender");
  const [windowSaving, setWindowSaving] = useState(false);
  const [autoAdjustWindow, setAutoAdjustWindow] = useState(false);
  const [autoAdjustToggling, setAutoAdjustToggling] = useState(false);

  const [testTo, setTestTo] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [testChecking, setTestChecking] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testReply, setTestReply] = useState<TestReply | null>(null);
  const [testWarning, setTestWarning] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const mountedRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptsRef = useRef(0);

  const load = async () => {
    try {
      const res = await apiFetch("/api/settings/email");
      if (!res.ok) return;
      const data = await res.json();
      if (!mountedRef.current) return;

      const connectedAt = data.settings.gmail_connected_at ?? null;
      const configured = data.settings.daily_send_limit ?? 30;
      const effective = data.effective_daily_limit ?? null;

      setGmailAddress(data.settings.gmail_address ?? null);
      setWarmupDay(
        connectedAt
          ? Math.floor(
              (Date.now() - new Date(connectedAt).getTime()) / 86400_000,
            ) + 1
          : null,
      );
      setEffectiveLimit(effective);
      setRamping(effective !== null && effective < configured);
      setFromName(data.settings.from_name ?? "");
      setReplyTo(data.settings.reply_to_email ?? "");
      setDailyLimit(String(configured));
      setSendingPaused(data.settings.sending_paused ?? false);
      setWindowStart(
        data.settings.send_window_start != null
          ? String(data.settings.send_window_start)
          : "",
      );
      setWindowEnd(
        data.settings.send_window_end != null
          ? String(data.settings.send_window_end)
          : "",
      );
      if (data.settings.send_timezone) {
        setWindowTimezone(data.settings.send_timezone);
      }
      setWindowScope(
        data.settings.send_window_scope === "recipient"
          ? "recipient"
          : "sender",
      );
      setAutoAdjustWindow(data.settings.auto_adjust_send_window ?? false);

      const testRes = await apiFetch("/api/settings/email/test");
      if (!testRes.ok || !mountedRef.current) return;
      const testData = await testRes.json();
      if (!mountedRef.current) return;

      // Keep whatever the user has already typed — load() also runs after a
      // save, and clobbering a half-typed address there would be maddening.
      setTestTo((prev) => prev || testData.suggested_to || "");

      // A finished test is terminal: show the stored verdict rather than
      // "waiting", which would imply we are still watching for a reply.
      const settled = testData.test?.status;
      if (settled === "replied" || settled === "bounced") {
        setTestStatus(settled);
        // Reply detail is persisted now, so a reload shows the same
        // confirmation the detecting tab did — excerpt included.
        setTestReply(
          testData.test.reply ??
            (testData.test.replied_at
              ? { at: testData.test.replied_at }
              : null),
        );
        setTestWarning(null);
      } else if (testData.test?.sent_at) {
        // An unsettled test survives a reload — which is the whole point of
        // persisting it, since the natural flow is send here, reply on your
        // phone, come back. Restore the waiting state with a manual "Check
        // now" rather than auto-polling: this test could be days old, and
        // resuming a 5-minute IMAP poll on every settings visit would burn
        // connections watching for a reply that is never coming.
        setTestStatus("waiting");
        setTestReply(null);
        setTestWarning(null);
      }
    } catch {
      // silently fail
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    // Same pattern as cost-center.tsx: the loader only touches state after
    // its awaits, so the sync-setState warning is a false positive here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      mountedRef.current = false;
      // A leaked interval keeps hitting IMAP long after this page is gone.
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, []);

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    attemptsRef.current = 0;
    setPolling(false);
  };

  const checkTest = async () => {
    setTestChecking(true);
    try {
      const res = await apiFetch("/api/settings/email/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check" }),
      });
      const data = await res.json();
      if (!mountedRef.current) return;

      if (!res.ok) {
        // Stop first, so a broken check surfaces one toast and not fifteen.
        stopPolling();
        toast.error(data.error ?? "Failed to check for a reply");
        return;
      }

      if (data.status === "replied" || data.status === "bounced") {
        setTestStatus(data.status);
        setTestReply(data.reply ?? null);
        setTestWarning(null);
        stopPolling();
        return;
      }

      // Still waiting. A `warning` means one IMAP attempt blipped, not that
      // the test failed — mention it, keep watching.
      setTestWarning(data.warning ?? null);
    } catch {
      // Soft — a dropped request should not end the watch.
    } finally {
      if (mountedRef.current) setTestChecking(false);
    }
  };

  const startPolling = () => {
    stopPolling();
    setPolling(true);
    attemptsRef.current = 0;
    pollRef.current = setInterval(() => {
      attemptsRef.current += 1;
      if (attemptsRef.current > MAX_POLLS) {
        stopPolling();
        return;
      }
      void checkTest();
    }, POLL_MS);
  };

  const handleSendTest = async () => {
    setTestSending(true);
    try {
      const res = await apiFetch("/api/settings/email/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", to: testTo.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to send test");
        return;
      }
      toast.success(`Test sent to ${data.test.to_email}`);
      setTestStatus("waiting");
      setTestReply(null);
      setTestWarning(null);
      startPolling();
    } catch {
      toast.error("Failed to send test");
    } finally {
      if (mountedRef.current) setTestSending(false);
    }
  };

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const res = await apiFetch("/api/settings/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "connect_gmail",
          gmail_address: addressInput.trim(),
          app_password: appPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to connect Gmail");
        return;
      }
      toast.success(`Connected ${data.gmail_address}`);
      setAppPassword("");
      setAddressInput("");
      await load();
    } catch {
      toast.error("Failed to connect Gmail");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      const res = await apiFetch("/api/settings/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disconnect_gmail" }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error ?? "Failed to disconnect");
        return;
      }
      toast.success("Gmail disconnected");
      await load();
    } catch {
      toast.error("Failed to disconnect");
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await apiFetch("/api/settings/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_name: fromName || null,
          reply_to_email: replyTo || null,
          daily_send_limit: Number(dailyLimit) || 30,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to save settings");
        return;
      }
      toast.success("Email settings saved");
      await load();
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveWindow = async () => {
    setWindowSaving(true);
    try {
      const start = windowStart === "" ? null : Number(windowStart);
      const end = windowEnd === "" ? null : Number(windowEnd);
      const res = await apiFetch("/api/settings/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_send_window",
          start,
          end,
          timezone: windowTimezone,
          scope: windowScope,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to save send window");
        return;
      }
      toast.success(
        start === null
          ? "Send window cleared: emails go out any time"
          : "Send window saved",
      );
      await load();
    } catch {
      toast.error("Failed to save send window");
    } finally {
      if (mountedRef.current) setWindowSaving(false);
    }
  };

  const handleToggleAutoAdjust = async (enabled: boolean) => {
    // Optimistic, matching the kill switch: an autonomy grant should flip
    // instantly and roll back on failure.
    setAutoAdjustWindow(enabled);
    setAutoAdjustToggling(true);
    try {
      const res = await apiFetch("/api/settings/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_auto_adjust_send_window",
          enabled,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAutoAdjustWindow(!enabled);
        toast.error(data.error ?? "Failed to update auto-adjust");
        return;
      }
      toast.success(
        enabled
          ? "The agent may now shift your send window toward hours that get replies"
          : "Send window auto-adjust turned off",
      );
    } catch {
      setAutoAdjustWindow(!enabled);
      toast.error("Failed to update auto-adjust");
    } finally {
      setAutoAdjustToggling(false);
    }
  };

  const handleTogglePause = async (paused: boolean) => {
    // Optimistic: a kill switch must flip instantly, not after a form save.
    setSendingPaused(paused);
    setPauseToggling(true);
    try {
      const res = await apiFetch("/api/settings/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_sending_paused", paused }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSendingPaused(!paused);
        toast.error(data.error ?? "Failed to update pause state");
        return;
      }
      toast.success(paused ? "All sending paused" : "Sending resumed");
    } catch {
      setSendingPaused(!paused);
      toast.error("Failed to update pause state");
    } finally {
      setPauseToggling(false);
    }
  };

  if (loading) {
    return (
      <SettingsSection
        title="Email"
        description="Connect your Gmail or Google Workspace mailbox for sending outreach."
      >
        <p className="text-muted-foreground text-sm">
          Loading email settings...
        </p>
      </SettingsSection>
    );
  }

  const statusBadge = gmailAddress ? (
    <span className="bg-success/10 text-success rounded-full px-2.5 py-0.5 text-xs font-medium">
      Connected
    </span>
  ) : (
    <span className="bg-muted text-muted-foreground rounded-full px-2.5 py-0.5 text-xs font-medium">
      Not connected
    </span>
  );

  return (
    <SettingsSection
      title="Email"
      description="Connect your Gmail or Google Workspace mailbox for sending outreach."
      actions={statusBadge}
    >
      <div className="space-y-4">
        {gmailAddress ? (
          <div className="space-y-1.5">
            <p className="text-sm">
              Sending as <span className="font-medium">{gmailAddress}</span>
            </p>
            {warmupDay !== null && (
              <p className="text-muted-foreground text-xs">
                {ramping
                  ? `Warming up: day ${warmupDay}, limited to ${effectiveLimit} sends/day today. The limit rises automatically over the first two weeks.`
                  : `Connected ${warmupDay} day${warmupDay === 1 ? "" : "s"} ago, fully ramped at ${effectiveLimit}/day.`}
              </p>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleDisconnect}
              disabled={disconnecting}
            >
              {disconnecting ? "Disconnecting..." : "Disconnect"}
            </Button>

            {/* Test send */}
            <div className="border-border mt-4 space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">Send a test</p>
              <div className="space-y-1.5">
                <div className="flex gap-2">
                  <Input
                    id="test-to"
                    type="email"
                    placeholder="you@somewhere-else.com"
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                    disabled={testSending}
                    onKeyDown={(e) => e.key === "Enter" && handleSendTest()}
                  />
                  <Button
                    onClick={handleSendTest}
                    disabled={testSending || !testTo.trim()}
                  >
                    {testSending ? "Sending..." : "Send test"}
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  Send this to a different mailbox you own. Signal ignores
                  replies from {gmailAddress}, so a test to yourself can never
                  show a reply. Test sends don&apos;t count against your daily
                  limit.
                </p>
              </div>

              {testStatus === "waiting" && (
                <div className="text-muted-foreground space-y-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    {polling && (
                      // Without a live indicator the card looks frozen between
                      // 20s ticks and the user cannot tell we are still
                      // watching. motion-safe so it respects reduced-motion.
                      <span
                        className="relative flex h-2 w-2 shrink-0"
                        aria-hidden="true"
                      >
                        <span className="bg-success absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full opacity-75" />
                        <span className="bg-success relative inline-flex h-2 w-2 rounded-full" />
                      </span>
                    )}
                    <p aria-live="polite">
                      {polling
                        ? testChecking
                          ? "Checking your inbox..."
                          : `Watching for your reply, checking every ${POLL_MS / 1000}s.`
                        : "No reply detected yet. Reply to the test, then check again."}
                    </p>
                  </div>
                  {testWarning && <p>{testWarning}</p>}
                  {/* Always offered, not just once polling gives up: the user
                      knows they replied well before the next tick, and making
                      them wait up to 20s for a round trip they already
                      completed is the whole complaint. */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void checkTest()}
                    disabled={testChecking}
                  >
                    {testChecking ? "Checking..." : "I've replied, check now"}
                  </Button>
                </div>
              )}

              {testStatus === "replied" && (
                <div className="space-y-1.5">
                  <p className="text-success text-xs">
                    {[
                      "Reply received",
                      testReply?.from ? ` from ${testReply.from}` : "",
                      testReply?.subject ? `, “${testReply.subject}”` : "",
                      testReply ? ` at ${formatLocalTime(testReply.at)}` : "",
                      ". Reply tracking is confirmed working.",
                    ].join("")}
                  </p>
                  {testReply?.snippet && (
                    // The reply's own words — the difference between trusting
                    // a green tick and seeing that it really was your message.
                    <blockquote className="border-success/40 text-muted-foreground border-l-2 pl-2 text-xs whitespace-pre-wrap">
                      {testReply.snippet}
                    </blockquote>
                  )}
                </div>
              )}

              {testStatus === "bounced" && (
                <p className="text-destructive text-xs">
                  That address bounced. Sending works: your mailbox delivered
                  the message and the recipient rejected it. This does not
                  confirm reply tracking; try again with a mailbox you can reply
                  from.
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <ol className="text-muted-foreground list-decimal space-y-1 pl-4 text-xs">
              <li>
                Turn on 2-Step Verification for your Google account (required
                for app passwords).
              </li>
              <li>
                Open{" "}
                <a
                  href="https://myaccount.google.com/apppasswords"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Google Account → App passwords
                </a>{" "}
                and generate one for &quot;Signal&quot;.
              </li>
              <li>Paste your address and the 16-character password below.</li>
            </ol>
            <div className="space-y-1.5">
              <label htmlFor="gmail-address" className="text-sm font-medium">
                Gmail / Workspace address
              </label>
              <Input
                id="gmail-address"
                type="email"
                placeholder="you@yourcompany.com"
                value={addressInput}
                onChange={(e) => setAddressInput(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="app-password" className="text-sm font-medium">
                App password
              </label>
              <Input
                id="app-password"
                type="password"
                placeholder="xxxx xxxx xxxx xxxx"
                value={appPassword}
                onChange={(e) => setAppPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleConnect()}
              />
              <p className="text-muted-foreground text-xs">
                Verified with a live login before saving, then stored encrypted.
                Signal sends through Google&apos;s servers, the best
                deliverability for cold outreach.
              </p>
            </div>
            <Button
              onClick={handleConnect}
              disabled={connecting || !addressInput.trim() || !appPassword}
            >
              {connecting ? "Verifying..." : "Connect Gmail"}
            </Button>
          </div>
        )}

        {/* Kill switch */}
        <div
          className={`flex items-center justify-between gap-4 rounded-lg border p-4 ${
            sendingPaused ? "border-destructive/50 bg-destructive/5" : ""
          }`}
        >
          <div className="space-y-1">
            <p className="text-sm font-medium">Pause all sending</p>
            <p className="text-muted-foreground text-xs">
              {sendingPaused
                ? "No emails will leave your mailbox. Follow-ups, send now, and agent sends are all blocked until you resume."
                : "Kill switch for every outbound email: follow-ups, send now, and agent sends. Drafting and reply tracking keep running."}
            </p>
          </div>
          <Switch
            checked={sendingPaused}
            onCheckedChange={handleTogglePause}
            disabled={pauseToggling}
            aria-label="Pause all sending"
          />
        </div>

        {/* Send window */}
        <div className="space-y-3 rounded-lg border p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Send window</p>
            <p className="text-muted-foreground text-xs">
              Scheduled sends (follow-ups, signal fires) only go out between
              these hours. A window past midnight is fine (e.g. 16:00 → 09:00).
              Send now and sends you confirm in chat ignore the window.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <label
                htmlFor="send-window-start"
                className="text-xs font-medium"
              >
                From
              </label>
              <Select
                id="send-window-start"
                aria-label="Send window start hour"
                value={windowStart}
                onValueChange={setWindowStart}
                items={HOUR_ITEMS}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="send-window-end" className="text-xs font-medium">
                Until
              </label>
              <Select
                id="send-window-end"
                aria-label="Send window end hour"
                value={windowEnd}
                onValueChange={setWindowEnd}
                items={HOUR_ITEMS}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <label
                htmlFor="send-window-timezone"
                className="text-xs font-medium"
              >
                Timezone
              </label>
              <Select
                id="send-window-timezone"
                aria-label="Send window timezone"
                value={windowTimezone}
                onValueChange={setWindowTimezone}
                items={TIMEZONE_ITEMS}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="send-window-scope" className="text-xs font-medium">
              Window applies in
            </label>
            <Select
              id="send-window-scope"
              aria-label="Send window scope"
              value={windowScope}
              onValueChange={setWindowScope}
              items={WINDOW_SCOPE_ITEMS}
            />
            {windowScope === "recipient" && (
              <p className="text-muted-foreground text-xs">
                Best effort: each contact&apos;s timezone is inferred from their
                location data. Contacts whose timezone can&apos;t be determined
                use your timezone above.
              </p>
            )}
          </div>
          {(windowStart === "") !== (windowEnd === "") && (
            <p className="text-warn text-xs">
              Pick both hours, or set both to “No window”.
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleSaveWindow}
            disabled={
              windowSaving || (windowStart === "") !== (windowEnd === "")
            }
          >
            {windowSaving ? "Saving..." : "Save send window"}
          </Button>

          {/* Auto-adjust opt-in */}
          <div className="flex items-center justify-between gap-4 border-t pt-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">Auto-adjust from reply data</p>
              <p className="text-muted-foreground text-xs">
                {windowStart === "" || windowEnd === ""
                  ? "Set a send window first. Once enough sends and replies accrue, the weekly analysis can shift it toward the hours that actually get replies."
                  : "The weekly analysis may shift this window toward the hours that get replies, once there is enough data (100+ sends). Every change is recorded as a timing learning you can review."}
              </p>
            </div>
            <Switch
              checked={autoAdjustWindow}
              onCheckedChange={handleToggleAutoAdjust}
              disabled={
                autoAdjustToggling || windowStart === "" || windowEnd === ""
              }
              aria-label="Auto-adjust send window from reply data"
            />
          </div>
        </div>

        {/* From Name */}
        <div className="space-y-1.5">
          <label htmlFor="from-name" className="text-sm font-medium">
            From Name
          </label>
          <Input
            id="from-name"
            type="text"
            placeholder="e.g. Jay Sahnan"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Display name shown in the recipient&apos;s inbox.
          </p>
        </div>

        {/* Reply-To */}
        <div className="space-y-1.5">
          <label htmlFor="reply-to" className="text-sm font-medium">
            Reply-To Email (optional)
          </label>
          <Input
            id="reply-to"
            type="email"
            placeholder="e.g. you@yourmaindomain.com"
            value={replyTo}
            onChange={(e) => setReplyTo(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Where replies go. Defaults to the connected address if empty.
          </p>
        </div>

        {/* Daily send limit */}
        <div className="space-y-1.5">
          <label htmlFor="daily-limit" className="text-sm font-medium">
            Daily send limit
          </label>
          <Input
            id="daily-limit"
            type="number"
            min={1}
            max={500}
            value={dailyLimit}
            onChange={(e) => setDailyLimit(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Cold-email hygiene: keep at 30 or below per mailbox. New mailboxes
            ramp up automatically over their first two weeks.
          </p>
        </div>

        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Email Settings"}
        </Button>
      </div>
    </SettingsSection>
  );
}
