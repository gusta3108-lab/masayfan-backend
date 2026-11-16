'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nextOrderSequence, formatPublicOrderNumber } = require('../lib/order-number');

test('first public order sequence starts after existing legacy orders', () => {
  assert.equal(nextOrderSequence(0, [{}, {}, { esPrueba: true }, {}]), 4);
});

test('sequence continues after counter and never goes below existing numeric references', () => {
  assert.equal(nextOrderSequence(8, [{ publicOrderNumber: '0012' }]), 13);
});

test('test orders do not consume public order numbers', () => {
  assert.equal(nextOrderSequence(0, [{ esPrueba: true }, { esPrueba: true }]), 1);
});

test('public order number is four digits and expands beyond 9999', () => {
  assert.equal(formatPublicOrderNumber(1), '0001');
  assert.equal(formatPublicOrderNumber(42), '0042');
  assert.equal(formatPublicOrderNumber(10000), '10000');
  assert.throws(() => formatPublicOrderNumber(0), /ORDER_SEQUENCE_INVALID/);
});
