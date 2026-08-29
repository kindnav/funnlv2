// Safely resolve a Supabase query builder to its result, converting any rejection
// (network error, aborted request, SDK bug) into a benign fallback.
//
// Why this exists: a Supabase query builder (e.g. the value returned by
// `.maybeSingle()`) is a *thenable* — it implements `.then()` but NOT `.catch()` or
// `.finally()`. Calling `.catch()` directly on it throws
// `TypeError: ...maybeSingle(...).catch is not a function`. Wrapping it in
// `Promise.resolve(...)` adopts the thenable and returns a real Promise, so a proper
// rejection handler can run. No `.catch` is ever called on the builder itself.
//
// Resolves to the builder's `{ data, error }` on success, or `fallback` (default
// `{ data: null, error }`) if the builder rejects. Pure — no imports; unit-testable.
export function settleQuery(builder, fallback) {
  return Promise.resolve(builder).then(
    (result) => result,
    (error) => (fallback !== undefined ? fallback : { data: null, error }),
  )
}
