// Display-only copy for the Funnl Pro price.
//
// Stripe and STRIPE_PRO_PRICE_ID remain the single source of truth for the
// amount actually charged. This constant is UI text only — it must be kept in
// sync with the active Stripe Pro price by hand. It intentionally does NOT hit
// Stripe or any API; it is plain display copy.
export const PRO_PRICE_DISPLAY = '$4.99/month'
