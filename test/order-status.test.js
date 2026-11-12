'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canTransitionOrderStatus, canTransitionTestOrderStatus, canRejectOrder } = require('../lib/order-status');

test('allows the normal order lifecycle', () => {
  assert.equal(canTransitionOrderStatus('nuevo', 'preparacion'), true);
  assert.equal(canTransitionOrderStatus('preparacion', 'listo'), true);
  assert.equal(canTransitionOrderStatus('listo', 'finalizado'), true);
});

test('allows rejection before delivery', () => {
  assert.equal(canTransitionOrderStatus('nuevo', 'rechazado'), true);
  assert.equal(canTransitionOrderStatus('preparacion', 'rechazado'), true);
  assert.equal(canTransitionOrderStatus('listo', 'rechazado'), true);
});

test('prevents reopening rejected or delivered orders', () => {
  assert.equal(canTransitionOrderStatus('rechazado', 'nuevo'), false);
  assert.equal(canTransitionOrderStatus('rechazado', 'preparacion'), false);
  assert.equal(canTransitionOrderStatus('finalizado', 'rechazado'), false);
  assert.equal(canTransitionOrderStatus('finalizado', 'nuevo'), false);
});

test('prevents skipping workflow stages', () => {
  assert.equal(canTransitionOrderStatus('nuevo', 'finalizado'), false);
  assert.equal(canTransitionOrderStatus('nuevo', 'listo'), false);
  assert.equal(canTransitionOrderStatus('preparacion', 'finalizado'), false);
});

test('treats repeated status updates as idempotent', () => {
  assert.equal(canTransitionOrderStatus('nuevo', 'nuevo'), true);
  assert.equal(canTransitionOrderStatus('rechazado', 'rechazado'), true);
});

test('defaults missing current status to nuevo and rejects unknown statuses', () => {
  assert.equal(canTransitionOrderStatus(undefined, 'preparacion'), true);
  assert.equal(canTransitionOrderStatus('unknown', 'finalizado'), false);
});


test('requires a confirmed Mercado Pago refund before rejecting a paid order', () => {
  assert.equal(canRejectOrder({ paymentMethod: 'mercadopago', paymentStatus: 'approved' }), false);
  assert.equal(canRejectOrder({ paymentMethod: 'mercadopago', paymentStatus: 'charged_back' }), false);
  assert.equal(canRejectOrder({ paymentMethod: 'mercadopago', paymentStatus: 'refunded' }), true);
  assert.equal(canRejectOrder({ paymentMethod: 'efectivo', paymentStatus: 'pending' }), true);
  assert.equal(canRejectOrder({ paymentMethod: 'prueba', paymentStatus: 'not_applicable' }), true);
});


test('allows test orders to be accepted or rejected only from the new state', () => {
  assert.equal(canTransitionTestOrderStatus('nuevo', 'preparacion'), true);
  assert.equal(canTransitionTestOrderStatus('nuevo', 'rechazado'), true);
  assert.equal(canTransitionTestOrderStatus('preparacion', 'listo'), false);
  assert.equal(canTransitionTestOrderStatus('rechazado', 'nuevo'), false);
  assert.equal(canTransitionTestOrderStatus('finalizado', 'rechazado'), false);
});
