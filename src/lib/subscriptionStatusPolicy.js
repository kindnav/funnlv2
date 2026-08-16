// Frontend re-export of the CANONICAL subscription-status policy.
//
// The single implementation lives at supabase/functions/shared/subscriptionStatusPolicy.js
// (the repo's established Edge shared location) so the Supabase deployer resolves it from
// the Edge function module graph. The frontend imports the exact same pure module through
// this thin re-export — there is no duplicated status map. The module has zero runtime
// dependencies, so Vite bundles it without issue.
export * from '../../supabase/functions/shared/subscriptionStatusPolicy.js'
