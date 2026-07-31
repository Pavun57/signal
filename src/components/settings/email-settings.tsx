"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "@/components/settings/settings-section";
import { apiFetch } from "@/lib/api-fetch";

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

  const mountedRef = useRef(true);

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
    };
  }, []);

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
                  ? `Warming up: day ${warmupDay} — limited to ${effectiveLimit} sends/day today. The limit rises automatically over the first two weeks.`
                  : `Connected ${warmupDay} day${warmupDay === 1 ? "" : "s"} ago — fully ramped at ${effectiveLimit}/day.`}
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
                Signal sends through Google&apos;s servers — best deliverability
                for cold outreach.
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
