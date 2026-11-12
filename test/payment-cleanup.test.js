'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PAYMENT_SEARCH_GRACE_MS, shouldReleaseExpiredReservation } = require('../lib/payment-cleanup');

const now = Date.now();
const expiredPending = {
  preferenceId: 'pref-123',
  inventoryReleased: false,
  expiresAt: new Date(now - PAYMENT_SEARCH_GRACE_MS - 1000)
};

test('keeps reservation when payment search reports an approved payment', () => {
  assert.equal(shouldReleaseExpiredReservation(expiredPending, [{ status: 'approved' }], now), false);
});

test('keeps reservation when payment is pending or in process', () => {
  assert.equal(shouldReleaseExpiredReservation(expiredPending, [{ status: 'pending' }], now), false);
  assert.equal(shouldReleaseExpiredReservation(expiredPending, [{ status: 'in_process' }], now), false);
});

test('releases only when every payment is definitively rejected or cancelled', () => {
  assert.equal(shouldReleaseExpiredReservation(expiredPending, [{ status: 'rejected' }, { status: 'cancelled' }], now), true);
  assert.equal(shouldReleaseExpiredReservation(expiredPending, [{ status: 'rejected' }, { status: 'approved' }], now), false);
});

test('does not release on an empty search until the indexing grace period passes', () => {
  const recent = { ...expiredPending, expiresAt: new Date(now - PAYMENT_SEARCH_GRACE_MS + 1000) };
  assert.equal(shouldReleaseExpiredReservation(recent, [], now), false);
  assert.equal(shouldReleaseExpiredReservation(expiredPending, [], now), true);
});

test('fails closed for missing preference and ambiguous review flags', () => {
  assert.equal(shouldReleaseExpiredReservation({ ...expiredPending, preferenceId: null }, [], now), false);
  assert.equal(shouldReleaseExpiredReservation({ ...expiredPending, preferenceCreationNeedsReview: true }, [], now), false);
  assert.equal(shouldReleaseExpiredReservation({ ...expiredPending, paymentApprovedNeedsReview: true }, [{ status: 'rejected' }], now), false);
});

test('fails closed for unknown payment status or malformed search results', () => {
  assert.equal(shouldReleaseExpiredReservation(expiredPending, [{ status: 'mystery' }], now), false);
  assert.equal(shouldReleaseExpiredReservation(expiredPending, null, now), false);
});
