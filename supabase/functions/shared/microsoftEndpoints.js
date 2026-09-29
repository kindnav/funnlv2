// Provider endpoint resolution, with a LOOPBACK-ONLY test seam.
//
// The integration suite must drive the callback end to end without contacting
// Microsoft or Graph. That requires redirecting the token, JWKS and Graph URLs
// at a local fixture server — which is exactly the kind of seam an attacker
// would love, because redirecting the token endpoint would send the
// authorization code and the client secret to a host of their choosing.
//
// So the override is constrained twice over:
//   1. it is ignored unless OUTLOOK_LOCAL_FIXTURES is exactly 'true';
//   2. the base must parse as http(s) on a LOOPBACK host - 127.0.0.1, ::1,
//      localhost, or host.docker.internal (the container's view of the host).
//      Anything else is refused and production endpoints are used instead.
//
// Neither condition is satisfiable in Production: the variable is never set,
// and even if it were, a public host could not pass the loopback check.

import { MS_TOKEN_ENDPOINT } from './microsoftOauthHelpers.js'
import { GRAPH_ME_URL } from './microsoftGraphMe.js'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', 'host.docker.internal'])

/** True only for an http(s) URL whose host is loopback. */
export function isLoopbackBase (raw) {
  if (typeof raw !== 'string' || raw.length === 0) return false
  let u
  try { u = new URL(raw) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  // URL.hostname keeps the brackets on an IPv6 literal ("[::1]").
  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, '')
  return LOOPBACK_HOSTS.has(host)
}

/**
 * Resolve the three provider endpoints.
 * `env` is a getter so this is pure and testable.
 */
export function resolveMicrosoftEndpoints (env = (k) => Deno.env.get(k)) {
  const production = {
    tokenUrl: MS_TOKEN_ENDPOINT,
    jwksBase: null,          // null => derive the tenant-specific URL normally
    graphMeUrl: GRAPH_ME_URL,
    usingFixtures: false,
  }
  if ((env('OUTLOOK_LOCAL_FIXTURES') ?? '') !== 'true') return production
  const base = env('OUTLOOK_FIXTURE_BASE') ?? ''
  if (!isLoopbackBase(base)) return production
  const trimmed = base.replace(/\/+$/, '')
  return {
    tokenUrl: `${trimmed}/token`,
    jwksBase: `${trimmed}/jwks`,
    graphMeUrl: `${trimmed}/me`,
    usingFixtures: true,
  }
}

/**
 * With fixtures the tenant-specific JWKS URL collapses to one local endpoint;
 * in production the caller's tenant-derived URL is used unchanged.
 */
export function resolveJwksUrl (endpoints, tenantDerivedUrl) {
  return endpoints.usingFixtures ? endpoints.jwksBase : tenantDerivedUrl
}
