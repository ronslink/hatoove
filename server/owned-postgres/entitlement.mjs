/** Null expiry preserves legacy credit validity. Reservations already made may settle later. */
export function entitlementExpired(row, now = Date.now()) {
  return row?.expires_at != null && new Date(row.expires_at).getTime() <= now;
}
export function entitlementDto(row) {
  return row ? { allowance: Number(row.allowance), used: Number(row.used), reserved: Number(row.reserved),
    expiresAt: row.expires_at == null ? null : new Date(row.expires_at).toISOString() } : null;
}
