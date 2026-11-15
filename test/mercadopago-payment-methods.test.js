'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMercadoPagoPaymentMethods } = require('../lib/mercadopago-payment-methods');

test('Mercado Pago keeps card methods enabled and caps payment at one installment', () => {
  const methods = buildMercadoPagoPaymentMethods();
  assert.equal(methods.installments, 1);
  assert.equal(methods.default_installments, 1);
  assert.equal(Object.hasOwn(methods, 'excluded_payment_types'), false);
  assert.equal(Object.hasOwn(methods, 'excluded_payment_methods'), false);
});
