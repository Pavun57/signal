/**
 * Liveness probe.
 *
 * docker-compose.yaml has always health-checked this path, and it did not
 * exist, so every self-hosted container sat permanently `unhealthy` and
 * anything keyed on that (compose `depends_on: service_healthy`, autoheal
 * sidecars, k8s converters) either restarted the app forever or refused to
 * start it.
 *
 * Deliberately does not touch the database or any provider. A health check
 * that fails when Postgres is briefly unreachable makes the orchestrator
 * restart a process that was fine, which is the opposite of useful. This
 * answers one question: is the Next.js server up and serving?
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
