import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DashboardShell } from "@/components/dashboard-shell";
import { MissingKeyBannerStack } from "@/components/missing-key-banner-stack";
import { PostHogIdentify } from "@/components/posthog-identify";
import { StreamingProvider } from "@/lib/streaming-context";
import "./globals.css";

export const metadata: Metadata = {
  title: "Signal",
  description: "Signal Dashboard",
};

// Read at request time (this is a server component) rather than relying on the
// SDK's build-time-inlined NEXT_PUBLIC_ lookup, which freezes empty in Docker
// images built without build args. See proxy.ts for the same pattern.
const clerkPublishableKey =
  process.env.CLERK_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} font-sans antialiased`}
      >
        <ClerkProvider
          appearance={{ theme: shadcn }}
          publishableKey={clerkPublishableKey}
        >
          <PostHogIdentify />
          <ThemeProvider
            attribute="class"
            defaultTheme="light"
            storageKey="signal-theme"
            disableTransitionOnChange
          >
            <StreamingProvider>
              <TooltipProvider>
                <DashboardShell banner={<MissingKeyBannerStack />}>
                  {children}
                </DashboardShell>
                <Toaster richColors />
              </TooltipProvider>
            </StreamingProvider>
          </ThemeProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
