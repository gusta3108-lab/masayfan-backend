'use strict';

const PAYMENT_SEARCH_GRACE_MS = 30 * 60 * 1000;
const FINAL_NOT_APPROVED_STATUSES = new Set(['rejected', 'cancelled']);

function shouldReleaseExpiredReservation(pending, results, now = Date.now()) {
  if (!pending || pending.inventoryReleased === true) return false;
  if (pending.paymentApprovedNeedsReview === true || pending.preferenceCreationNeedsReview === true) return false;
  if (!pending.preferenceId) return false;

  const payments = Array.isArray(results) ? results : null;
  if (!payments) return false;

  if (payments.length > 0) {
    // Fail closed: every payment linked to this checkout must be definitively
    // rejected/cancelled. Pending, approved, refunded, reversed or unknown
    // states keep the reservation for reconciliation.
    return payments.every(payment =>
      FINAL_NOT_APPROVED_STATUSES.has(String(payment?.status || '').toLowerCase())
    );
  }

  const expiresAt = pending.expiresAt?.toDate
    ? pending.expiresAt.toDate().getTime()
    : new Date(pending.expiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return false;

  // Allow time for Mercado Pago's payment search index to catch up after the
  // preference expires. An empty search immediately after expiry is not proof.
  return now - expiresAt >= PAYMENT_SEARCH_GRACE_MS;
}

module.exports = { PAYMENT_SEARCH_GRACE_MS, shouldReleaseExpiredReservation };
