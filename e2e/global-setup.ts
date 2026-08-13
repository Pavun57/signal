import { config } from "dotenv";

config({ path: ".env.local" });

export default async function globalSetup() {
  // Nothing to provision globally: each test creates its own Supabase users
  // through the service-role admin API (see e2e/helpers.ts createTestUser)
  // and cleans them up afterwards.
}
