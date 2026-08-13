import { connection } from "next/server";
import {
  INTEGRATIONS,
  isIntegrationConfigured,
  missingEnvVarsFor,
} from "@/lib/integrations";
import { MissingKeyBanner } from "@/components/missing-key-banner";

/**
 * Renders one `<MissingKeyBanner />` per missing required integration.
 *
 * Server component — reads `process.env` directly so it works even when the
 * DB or auth provider is the thing that's missing. Mount it in the root
 * layout (above any code that touches Supabase / Clerk / etc.) so the user
 * gets a "you're missing X" banner instead of a blank page when the layer
 * that powers the rest of the app isn't configured.
 *
 * Optional integrations are not banner-worthy — those surface in the
 * /settings integrations panel instead.
 */
export async function MissingKeyBannerStack() {
  // Read env per request, not per build. Without this the component gets
  // statically prerendered with the build container's env, so a Docker image
  // built without the unprefixed keys (CLERK_SECRET_KEY, AI_API_KEY, …) shows
  // "not configured" banners forever, even when the running container has
  // them — contradicting the Integrations tab, which checks at request time.
  await connection();

  const missingRequired = INTEGRATIONS.filter((integration) => {
    if (integration.severity !== "required") return false;
    return !isIntegrationConfigured(integration);
  });

  if (missingRequired.length === 0) return null;

  return (
    <>
      {missingRequired.map((integration) => (
        <MissingKeyBanner
          key={integration.id}
          integration={integration}
          missingEnvVars={missingEnvVarsFor(integration)}
        />
      ))}
    </>
  );
}
