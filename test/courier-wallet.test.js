'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCourierEarning, summarizeCourierWallet } = require('../lib/courier-wallet');

test('cash order separates store share from courier fee and marks fee already received', () => {
  assert.deepEqual(buildCourierEarning({ total: 20000, paymentMethod: 'efectivo' }, 4000), {
    total: 20000,
    courierFee: 4000,
    storeAmount: 16000,
    paymentMethod: 'efectivo',
    earningStatus: 'cash_received'
  });
});

test('online order credits courier fee as pending and does not reduce store collection', () => {
  assert.deepEqual(buildCourierEarning({ total: 20000, paymentMethod: 'mercadopago' }, 4000), {
    total: 20000,
    courierFee: 4000,
    storeAmount: 16000,
    paymentMethod: 'mercadopago',
    earningStatus: 'online_pending'
  });
});

test('courier fee cannot exceed order total or be negative', () => {
  assert.throws(() => buildCourierEarning({ total: 20000 }, 20001), /COURIER_FEE_INVALID/);
  assert.throws(() => buildCourierEarning({ total: 20000 }, -1), /COURIER_FEE_INVALID/);
  assert.throws(() => buildCourierEarning({ total: 0 }, 100), /ORDER_TOTAL_INVALID/);
});

test('wallet pays online earnings less cash earnings already received and previous payouts', () => {
  const wallet = summarizeCourierWallet([
    { amount: 4000, status: 'cash_received' },
    { amount: 4000, status: 'online_pending' },
    { amount: 4000, status: 'online_pending' }
  ], [{ amount: 2000, status: 'paid' }]);
  assert.deepEqual(wallet, {
    totalEarned: 12000,
    cashReceived: 4000,
    onlineEarned: 8000,
    paidOut: 2000,
    balanceToPay: 6000
  });
});

test('wallet never displays a negative amount payable to courier', () => {
  const wallet = summarizeCourierWallet([
    { amount: 4000, status: 'cash_received' }
  ], [{ amount: 1000, status: 'paid' }]);
  assert.equal(wallet.balanceToPay, 0);
});
