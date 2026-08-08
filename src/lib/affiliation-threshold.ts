/**
 * Minimum affiliation confidence to be contacted. Sits just below
 * llm_verified, so a positive LLM judgement is enough to email someone but a
 * bare search hit is not.
 *
 * Lives in its own module because both server code (the send gate in
 * services/affiliation) and client components (provenance badge, companies
 * list) need it, and the service module drags server-only imports into any
 * client bundle that touches it. The service re-exports this constant, so
 * there is still exactly one definition.
 */
export const AFFILIATION_SEND_THRESHOLD = 0.6;
