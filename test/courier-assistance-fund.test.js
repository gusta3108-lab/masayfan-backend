'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateBusinessContribution,
  buildBusinessContributionEntry
} = require('../lib/courier-assistance-fund');

test('disabled fund does not create a contribution', () => {
  assert.equal(calculateBusinessContribution({ enabled: false, fixedAmount: 500, courierFee: 4500 }), 0);
});

test('fixed contribution is funded by the business and does not reduce courier payout', () => {
  const entry = buildBusinessContributionEntry({
    orderId: 'order-123',
    deliveryStatus: 'delivered',
    courierFee: 4500,
    config: { enabled: true, mode: 'fixed', fixedAmount: 500 },
    createdAt: '2026-11-15T00:00:00.000Z'
  });
  assert.equal(entry.amount, 500);
  assert.equal(entry.courierDeduction, 0);
  assert.equal(entry.courierPayoutReduced, false);
  assert.equal(entry.source, 'business_contribution');
});

test('percentage contribution is calculated from the agreed courier fee', () => {
  assert.equal(calculateBusinessContribution({
    enabled: true, mode: 'percentage', percentage: 10, courierFee: 4500
  }), 450);
});

test('no contribution is accrued for a delivery that is not completed', () => {
  assert.throws(() => buildBusinessContributionEntry({
    orderId: 'order-123',
    deliveryStatus: 'in_transit',
    courierFee: 4500,
    config: { enabled: true, mode: 'fixed', fixedAmount: 500 }
  }), /FUND_ONLY_COMPLETED_DELIVERIES/);
});

test('invalid values and unsupported modes are rejected', () => {
  assert.throws(() => calculateBusinessContribution({
    enabled: true, mode: 'percentage', percentage: 101, courierFee: 4500
  }), /FUND_PERCENTAGE_INVALID/);
  assert.throws(() => calculateBusinessContribution({
    enabled: true, mode: 'fixed', fixedAmount: -1, courierFee: 4500
  }), /FUND_FIXED_AMOUNT_INVALID/);
  assert.throws(() => calculateBusinessContribution({
    enabled: true, mode: 'unknown', courierFee: 4500
  }), /FUND_MODE_INVALID/);
});
