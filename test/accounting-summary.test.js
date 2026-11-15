'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeAccounting, dateKeyInArgentina, monthKeyInArgentina } = require('../lib/accounting-summary');

test('Argentina local date keys handle the configured business timezone', () => {
  assert.equal(dateKeyInArgentina('2026-11-15T02:30:00.000Z'), '2026-11-14');
  assert.equal(monthKeyInArgentina('2026-11-15T02:30:00.000Z'), '2026-11');
});

test('summary separates gross sales from paid amounts and excludes test orders', () => {
  const result = summarizeAccounting({
    now: new Date('2026-11-15T15:00:00.000Z'),
    orders: [
      { total: 100000, status: 'finalizado', paymentStatus: 'cash_received', paymentMethod: 'efectivo', createdAt: '2026-11-15T14:00:00.000Z' },
      { total: 50000, status: 'nuevo', paymentStatus: 'pending', paymentMethod: 'efectivo', createdAt: '2026-11-15T13:00:00.000Z' },
      { total: 90000, status: 'finalizado', paymentStatus: 'approved', paymentMethod: 'mercadopago', createdAt: '2026-11-02T13:00:00.000Z' },
      { total: 999999, esPrueba: true, status: 'finalizado', paymentStatus: 'approved', createdAt: '2026-11-15T14:00:00.000Z' }
    ]
  });
  assert.equal(result.sales.grossToday, 150000);
  assert.equal(result.sales.paidToday, 100000);
  assert.equal(result.sales.grossMonth, 240000);
  assert.equal(result.sales.paidMonth, 190000);
  assert.equal(result.sales.ordersToday, 2);
});

test('fund balance is contributions minus approved assistance payments only', () => {
  const result = summarizeAccounting({
    orders: [],
    fundMovements: [
      { type: 'contribution', status: 'posted', amount: 500 },
      { type: 'contribution', status: 'posted', amount: 250 },
      { type: 'assistance', status: 'posted', amount: 300 },
      { type: 'assistance', status: 'pending', amount: 1000 },
      { type: 'contribution', status: 'void', amount: 800 }
    ]
  });
  assert.equal(result.assistanceFund.contributions, 750);
  assert.equal(result.assistanceFund.assistancePaid, 300);
  assert.equal(result.assistanceFund.bookBalance, 450);
  assert.equal(result.assistanceFund.bankReconciled, false);
});
