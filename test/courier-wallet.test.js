'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCourierOffer, acceptCourierOffer, buildCourierEarning, summarizeCourierWallet
} = require('../lib/courier-wallet');

const courierId = 'a'.repeat(64);

test('admin offer is per-order, pending, and separates store amount', () => {
  const offer = buildCourierOffer({ total: 20000 }, 4000, courierId, 'ADMIN@MASAY.COM');
  assert.equal(offer.amount, 4000);
  assert.equal(offer.storeAmount, 16000);
  assert.equal(offer.status, 'pending');
  assert.equal(offer.offeredBy, 'admin@masay.com');
});

test('accepted offer freezes the exact amount for the order', () => {
  const offer = buildCourierOffer({ total: 20000 }, 4500, courierId, 'admin@masay.com');
  const accepted = acceptCourierOffer({ total: 20000 }, offer);
  assert.equal(accepted.courierId, courierId);
  assert.equal(accepted.courierFee, 4500);
  assert.equal(accepted.storeAmount, 15500);
  assert.equal(accepted.offerAccepted, true);
  assert.ok(accepted.acceptedAt);
});

test('cash earning is not marked received before delivery and customer payment', () => {
  assert.deepEqual(buildCourierEarning({ total: 20000, paymentMethod: 'efectivo' }, 4000), {
    total: 20000, courierFee: 4000, storeAmount: 16000,
    paymentMethod: 'efectivo', earningStatus: 'cash_to_collect'
  });
});

test('online earning remains payable by Masay', () => {
  assert.equal(buildCourierEarning({ total: 20000, paymentMethod: 'mercadopago' }, 4000).earningStatus, 'online_pending');
});

test('offers must be positive and cannot exceed the order total', () => {
  assert.throws(() => buildCourierOffer({ total: 20000 }, 0, courierId), /COURIER_OFFER_INVALID/);
  assert.throws(() => buildCourierOffer({ total: 20000 }, 20001, courierId), /COURIER_OFFER_INVALID/);
  assert.throws(() => buildCourierOffer({ total: 0 }, 100, courierId), /ORDER_TOTAL_INVALID/);
});

test('wallet offsets cash earnings against the amount Masay owes for online orders', () => {
  const wallet = summarizeCourierWallet([
    { amount: 4000, status: 'cash_received' },
    { amount: 4000, status: 'online_pending' },
    { amount: 4000, status: 'online_pending' },
    { amount: 3000, status: 'cash_to_collect' }
  ], [{ amount: 2000, status: 'paid' }]);
  assert.deepEqual(wallet, {
    totalEarned: 12000, cashReceived: 4000, cashToCollect: 3000,
    onlinePending: 4000, paidOut: 2000, balanceToPay: 2000
  });
});

test('cash compensation accumulates across multiple orders', () => {
  const wallet = summarizeCourierWallet([
    { amount: 12000, status: 'online_pending' },
    { amount: 3000, status: 'cash_received' },
    { amount: 2000, status: 'cash_received' }
  ]);
  assert.equal(wallet.onlinePending, 12000);
  assert.equal(wallet.cashReceived, 5000);
  assert.equal(wallet.balanceToPay, 7000);
});

test('offer cannot be accepted after it is no longer pending', () => {
  assert.throws(() => acceptCourierOffer({ total: 20000 }, { courierId, amount: 4000, status: 'rejected' }), /OFFER_NOT_AVAILABLE/);
});
