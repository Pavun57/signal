-- Re-seed the built-in signals
-- 2026-08-04
--
-- The 11 built-ins are inserted by 20260419000000_initial_schema.sql and then
-- deleted again by 20260427000000_clerk_auth_migration.sql, four migrations
-- later, on every database that has ever been created.
--
-- That migration truncates user_profile (among others) with CASCADE. TRUNCATE
-- CASCADE reaches every table holding a foreign key into the truncated set,
-- and signals.created_by references user_profile(id), so signals goes with it
-- -- and signal_results after that. The migration's own header says "Shared
-- pools -- organizations, people, signals, signal_results -- are untouched",
-- which is not what it does. Running `supabase db reset` on this branch before
-- this file existed left `select count(*) from signals` at 0.
--
-- The effect on a fresh install is that the Signals page reads "No signals in
-- this category" and the product's central concept is simply absent, with no
-- error to explain it. Existing installs lost them at the same point and were
-- repopulated by hand, which is why this went unnoticed.
--
-- Fixed forward rather than by editing 0427: that migration is applied history
-- on every existing database, so changing it would not re-run.
--
-- `on conflict (slug) do nothing` makes this safe to replay and safe on an
-- install whose built-ins are already present. Rows are inserted with
-- created_by null, which is correct -- a built-in belongs to no user, and the
-- signals_update/delete policies require `is_builtin = false`, so nobody can

insert into public.signals (name, slug, description, long_description, category, icon, execution_type, tool_key, config, is_builtin)
values ('Changelog Monitor', 'changelog-monitor', 'Watch for new releases, changelogs, and "what''s new" announcements.', 'Uses semantic search to find recent changelog entries, release notes, and product update posts. Active shipping cadence indicates an engineering-led org investing in their product -- a proxy for budget in adjacent tooling. Fresh releases are natural outreach hooks.', 'product', 'Rocket', 'exa_search', NULL, '{"query": "{company} changelog OR release notes OR what''s new", "category": "news"}'::jsonb, true)
on conflict (slug) do nothing;

insert into public.signals (name, slug, description, long_description, category, icon, execution_type, tool_key, config, is_builtin)
values ('Executive Changes', 'executive-changes', 'Detect new hires, promotions, and leadership changes at target companies.', 'Searches for recent executive appointments, promotions, and leadership changes. New leaders in relevant roles often bring new budgets and initiatives -- a strong timing signal for outreach.', 'executive', 'UserCog', 'exa_search', NULL, '{"query": "new {title} appointed OR hired OR promoted at {company}", "category": "news"}'::jsonb, true)
on conflict (slug) do nothing;

insert into public.signals (name, slug, description, long_description, category, icon, execution_type, tool_key, config, is_builtin)
values ('Funding & News', 'funding-news', 'Search for recent funding rounds, acquisitions, and company news.', 'Uses semantic search to find recent funding announcements, acquisitions, partnerships, and press coverage. Recent funding often means budget for new tools and services. Major news events create natural outreach hooks.', 'funding', 'TrendingUp', 'exa_search', NULL, '{"query": "{company} funding round OR acquisition OR raised series", "category": "news"}'::jsonb, true)
on conflict (slug) do nothing;

insert into public.signals (name, slug, description, long_description, category, icon, execution_type, tool_key, config, is_builtin)
values ('GitHub Stargazers', 'github-stargazers', 'Fetch actual stargazers from a company''s GitHub repos to find developers and decision-makers.', 'Uses the GitHub API to fetch the real people who recently starred a company''s repositories. Returns full profiles: name, company, location, bio, follower count, and when they starred. Aggregates which companies and locations are represented. Useful for finding developers interested in specific technologies, identifying companies with active dev communities, and discovering technical decision-makers.', 'engagement', 'Star', 'tool_call', 'fetchGitHubStargazers', '{"maxStargazers": 10}'::jsonb, true)
on conflict (slug) do nothing;

insert into public.signals (name, slug, description, long_description, category, icon, execution_type, tool_key, config, is_builtin)
values ('Google Reviews', 'google-reviews', 'Fetch Google ratings and reviews to gauge customer sentiment and reputation.', 'Uses the Google Places API to find a company''s Google Business listing and extract their rating, review count, and recent review text. Strong ratings with high volume signal a healthy, established business. Negative review patterns can reveal pain points your product addresses. Review content provides natural conversation starters for outreach.', 'engagement', 'StarHalf', 'tool_call', 'getGoogleReviews', '{"maxReviews": 5}'::jsonb, true)
on conflict (slug) do nothing;

insert into public.signals (name, slug, description, long_description, category, icon, execution_type, tool_key, config, is_builtin)
values ('Hiring Activity', 'hiring-activity', 'Scrape careers pages to detect hiring patterns as buying signals.', 'Navigates to a company''s website, finds their careers or jobs page, and extracts structured job listings. Companies actively hiring for roles related to your offering are prime targets -- hiring volume, department focus, and role seniority all indicate budget and urgency.', 'hiring', 'Briefcase', 'browser_script', 'scrapeJobListings', '{"maxJobs": 20}'::jsonb, true)
on conflict (slug) do nothing;

insert into public.signals (name, slug, description, long_description, category, icon, execution_type, tool_key, config, is_builtin)
values ('Pricing Changes', 'pricing-changes', 'Track competitor and prospect pricing page changes over time.', 'Scrapes the company''s /pricing page, extracts every tier (name, price, billing period, top features), and diffs against the last 90 days of history. Surfaces added tiers, removed tiers, and price movements. Strong buying signal when a prospect raises prices (budget expansion) or a competitor changes positioning. Backed by a hardcoded Stagehand recipe.', 'product', 'TrendingUp', 'browser_script', NULL, '{}'::jsonb, true)
on conflict (slug) do nothing;

insert into public.signals (name, slug, description, long_description, category, icon, execution_type, tool_key, config, is_builtin)
values ('Product Launches', 'product-launches', 'Monitor for new product announcements and feature releases.', 'Tracks new product launches, major feature releases, and expansion announcements. Companies launching new products are often investing in supporting infrastructure, tooling, and services.', 'product', 'Rocket', 'exa_search', NULL, '{"query": "{company} launches OR announces OR releases new product OR feature", "category": "news"}'::jsonb, true)
on conflict (slug) do nothing;

insert into public.signals (name, slug, description, long_description, category, icon, execution_type, tool_key, config, is_builtin)
values ('Social Engagement', 'social-engagement', 'Analyze LinkedIn and Twitter activity for engagement signals.', 'Reviews recent social media activity from key contacts -- LinkedIn posts, Twitter engagement, and content themes. Active posters with relevant content are more receptive to outreach. Recent posts about pain points your product solves are golden timing signals.', 'engagement', 'MessageCircle', 'tool_call', 'enrichContact', '{"focus": "social_activity"}'::jsonb, true)
on conflict (slug) do nothing;

insert into public.signals (name, slug, description, long_description, category, icon, execution_type, tool_key, config, is_builtin)
values ('Terms & Conditions Changes', 'terms-conditions-changes', 'Detect updates to a company''s terms of service or privacy policy.', 'Navigates to the company''s terms and conditions or privacy policy page and extracts key terms, effective dates, and material changes. Policy updates often correlate with new products, pricing models, compliance initiatives, or geographic expansion -- all timing signals for outreach.', 'custom', 'Globe', 'browser_script', 'extractWebContent', '{"instructions": "Navigate to the terms and conditions or privacy policy page and extract key terms, dates, and changes."}'::jsonb, true)
on conflict (slug) do nothing;

insert into public.signals (name, slug, description, long_description, category, icon, execution_type, tool_key, config, is_builtin)
values ('Website & Tech Stack', 'website-tech-stack', 'Analyze company websites for technology signals and content.', 'Extracts and analyzes company website content, technology indicators, and messaging. Helps identify tech stack, positioning, growth stage, and potential pain points based on how they present themselves.', 'product', 'Globe', 'tool_call', 'extractWebContent', '{"includeStructuredData": true}'::jsonb, true)
on conflict (slug) do nothing;

