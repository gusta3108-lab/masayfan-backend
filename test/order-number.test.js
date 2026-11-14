'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reserveDisplayOrderNumber } = require('../lib/order-number');

function createTransaction() {
  const state = { value: null };
  return {
    state,
    async get() {
      return {
        exists: state.value !== null,
        data: () => state.value
      };
    },
    set(_ref, value, options) {
      assert.deepEqual(options, { merge: true });
      state.value = { ...(state.value || {}), ...value };
    }
  };
}

test('display order numbers start at 0001 and increase sequentially', async () => {
  const transaction = createTransaction();
  const counterRef = {};
  const FieldValue = { serverTimestamp: () => 'server-time' };

  assert.equal(await reserveDisplayOrderNumber(transaction, counterRef, FieldValue), '0001');
  assert.equal(await reserveDisplayOrderNumber(transaction, counterRef, FieldValue), '0002');
  assert.equal(await reserveDisplayOrderNumber(transaction, counterRef, FieldValue), '0003');
  assert.equal(transaction.state.value.lastNumber, 3);
});

test('display order numbers expand beyond four digits without wrapping or reuse', async () => {
  const transaction = createTransaction();
  transaction.state.value = { lastNumber: 9999 };
  const number = await reserveDisplayOrderNumber(transaction, {}, { serverTimestamp: () => 'server-time' });
  assert.equal(number, '10000');
  assert.equal(transaction.state.value.lastNumber, 10000);
});

test('invalid sequence state is rejected instead of generating a duplicate number', async () => {
  const transaction = createTransaction();
  transaction.state.value = { lastNumber: -1 };
  await assert.rejects(
    reserveDisplayOrderNumber(transaction, {}, { serverTimestamp: () => 'server-time' }),
    /ORDER_NUMBER_SEQUENCE_INVALID/
  );
});
