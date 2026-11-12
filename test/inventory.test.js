'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stockRequirements, shouldRetainInventoryReservation } = require('../lib/inventory');

test('aggregates valid quantities for repeated product lines', () => {
  assert.deepEqual(
    stockRequirements([
      { stockProductId: 'product-a', qty: 2 },
      { stockProductId: 'product-a', qty: '3' },
      { stockProductId: 'product-b', qty: 1 }
    ]),
    [
      { productId: 'product-a', qty: 5 },
      { productId: 'product-b', qty: 1 }
    ]
  );
});

for (const qty of [0, -1, 1.5, NaN, Infinity, 'not-a-number']) {
  test('rejects invalid inventory quantity: ' + String(qty), () => {
    assert.throws(
      () => stockRequirements([{ stockProductId: 'product-a', qty }]),
      /entero positivo/
    );
  });
}

test('rejects aggregate quantities outside the safe integer range', () => {
  assert.throws(
    () => stockRequirements([
      { stockProductId: 'product-a', qty: Number.MAX_SAFE_INTEGER },
      { stockProductId: 'product-a', qty: 1 }
    ]),
    /excede el límite permitido/
  );
});

test('keeps legacy order lines without a stock product identifier outside stock tracking', () => {
  assert.deepEqual(
    stockRequirements([{ id: 'legacy-product', qty: 2 }]),
    []
  );
});


test('retains a reservation while preference creation is ambiguous', () => {
  assert.equal(shouldRetainInventoryReservation({ preferenceCreationNeedsReview: true }), true);
});

test('does not release an approved payment awaiting administrative review', () => {
  assert.equal(shouldRetainInventoryReservation({ paymentApprovedNeedsReview: true, preferenceCreationNeedsReview: true }, { confirmedNotApproved: true }), true);
});

test('allows release after Mercado Pago confirms the payment was not approved', () => {
  assert.equal(shouldRetainInventoryReservation({ preferenceCreationNeedsReview: true }, { confirmedNotApproved: true }), false);
});

test('allows normal expiry cleanup when no review flag exists', () => {
  assert.equal(shouldRetainInventoryReservation({ inventoryReleased: false }), false);
});
