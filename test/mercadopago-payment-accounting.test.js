'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMercadoPagoAccounting } = require('../lib/mercadopago-payment-accounting');

test('normalizes actual Mercado Pago fees, net amount and installment metadata', () => {
  const result = buildMercadoPagoAccounting({
    transaction_amount: 10000,
    fee_details: [
      { type: 'mercadopago_fee', amount: 650, fee_payer: 'collector' },
      { type: 'tax', amount: 136.5, fee_payer: 'collector' }
    ],
    transaction_details: { net_received_amount: 9213.5 },
    installments: 1,
    payment_method_id: 'visa',
    payment_type_id: 'credit_card',
    date_approved: '2026-11-15T19:00:00.000Z'
  });
  assert.equal(result.grossAmount, 10000);
  assert.equal(result.feeTotal, 786.5);
  assert.equal(result.netReceivedAmount, 9213.5);
  assert.equal(result.installments, 1);
  assert.equal(result.paymentMethodId, 'visa');
  assert.equal(result.paymentTypeId, 'credit_card');
  assert.equal(result.feeDetails.length, 2);
});

test('missing fee and net data stay null instead of being presented as zero', () => {
  const result = buildMercadoPagoAccounting({
    transaction_amount: 1000,
    fee_details: [],
    transaction_details: {},
    installments: 1
  });
  assert.equal(result.feeTotal, null);
  assert.equal(result.netReceivedAmount, null);
});

test('invalid fee rows are ignored and invalid values are not fabricated', () => {
  const result = buildMercadoPagoAccounting({
    fee_details: [{ type: 'bad', amount: 'not-a-number' }, { type: 'fee', amount: -1 }],
    transaction_details: { net_received_amount: 'unknown' }
  });
  assert.equal(result.feeTotal, null);
  assert.equal(result.netReceivedAmount, null);
  assert.equal(result.feeDetails.length, 0);
});
