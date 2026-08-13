import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  "/login(.*)",
  "/signup(.*)",
  "/api/jobs(.*)",
  // Container orchestrators cannot present a session, and a health check that
  // 307s to /login tells them nothing. Returns a fixed literal, reads nothing.
  "/api/health",
]);

// Next inlines NEXT_PUBLIC_* references into the server bundle at build time,
// so in a Docker image built without build args the SDK's default lookup of
// NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is frozen as empty no matter what the
// container's runtime env says. Reading the unprefixed CLERK_PUBLISHABLE_KEY
// happens at true request time, so self-hosters can set it on the container.
const publishableKey =
  process.env.CLERK_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export const proxy = clerkMiddleware(
  async (auth, request) => {
    if (!isPublicRoute(request)) await auth.protect();
  },
  publishableKey ? { publishableKey } : {},
);

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
