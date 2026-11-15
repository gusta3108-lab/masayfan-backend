'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeAccounting, dateKeyInArgentina, monthKeyInArgentina } = require('../lib/accounting-summary');

test('Argentina local date keys handle the configured business timezone', () => {
  assert.equal(dateKeyInArgentina('2026-11-15T02:30:00.000Z'), '2026-11-14');
  assert.equal(monthKeyInArgentina('2026-11-15T02:30:00.000Z'), '2026-11');
});

test('summary separates cash, online, pending and gross sales; excludes test orders', () => {
  const result = summarizeAccounting({
    now: new Date('2026-11-15T15:00:00.000Z'),
    orders: [
      { total: 100000, status: 'finalizado', paymentStatus: 'cash_received', paymentMethod: 'efectivo', createdAt: '2026-11-15T14:00:00.000Z', paymentReceivedAt: '2026-11-15T14:30:00.000Z' },
      { total: 50000, status: 'nuevo', paymentStatus: 'pending', paymentMethod: 'efectivo', createdAt: '2026-11-15T13:00:00.000Z' },
      { total: 90000, status: 'finalizado', paymentStatus: 'approved', paymentMethod: 'mercadopago', createdAt: '2026-11-02T13:00:00.000Z' },
      { total: 25000, status: 'nuevo', paymentStatus: 'pending', paymentMethod: 'mercadopago', createdAt: '2026-11-12T13:00:00.000Z' },
      { total: 999999, esPrueba: true, status: 'finalizado', paymentStatus: 'approved', paymentMethod: 'mercadopago', createdAt: '2026-11-15T14:00:00.000Z' }
    ]
  });
  assert.equal(result.sales.grossToday, 150000);
  assert.equal(result.sales.cashCollectedToday, 100000);
  assert.equal(result.sales.onlineCollectedToday, 0);
  assert.equal(result.sales.totalCollectedToday, 100000);
  assert.equal(result.sales.pendingCollectionToday, 50000);
  assert.equal(result.sales.grossMonth, 265000);
  assert.equal(result.sales.cashCollectedMonth, 100000);
  assert.equal(result.sales.onlineCollectedMonth, 90000);
  assert.equal(result.sales.totalCollectedMonth, 190000);
  assert.equal(result.sales.pendingCollectionMonth, 75000);
  assert.equal(result.sales.ordersToday, 2);
  assert.equal(result.sales.deliveredOrdersMonth, 2);
  assert.equal(result.sales.deliveredOrdersToday, 1);
});

test('Mercado Pago fee and net totals use only values returned by the payment API', () => {
  const result = summarizeAccounting({
    now: new Date('2026-11-15T15:00:00.000Z'),
    orders: [
      {
        total: 10000, paymentMethod: 'mercadopago', paymentStatus: 'approved',
        createdAt: '2026-11-15T14:00:00.000Z',
        mercadoPagoAccounting: { feeTotal: 700, netReceivedAmount: 9300 }
      },
      {
        total: 5000, paymentMethod: 'mercadopago', paymentStatus: 'approved',
        createdAt: '2026-11-02T14:00:00.000Z'
      }
    ]
  });
  assert.equal(result.sales.onlineFeeToday, 700);
  assert.equal(result.sales.onlineNetReceivedToday, 9300);
  assert.equal(result.sales.onlineFeeMonth, 700);
  assert.equal(result.sales.onlineNetReceivedMonth, 9300);
  assert.equal(result.sales.onlinePaidOrdersMonth, 2);
  assert.equal(result.sales.onlineFeeDataCountMonth, 1);
});

test('cash collection is counted on the date it was actually received', () => {
  const result = summarizeAccounting({
    now: new Date('2026-11-15T15:00:00.000Z'),
    orders: [{
      total: 4200, paymentMethod: 'efectivo', paymentStatus: 'cash_received',
      createdAt: '2026-11-14T12:00:00.000Z',
      paymentReceivedAt: '2026-11-15T14:00:00.000Z'
    }]
  });
  assert.equal(result.sales.grossToday, 0);
  assert.equal(result.sales.cashCollectedToday, 4200);
  assert.equal(result.sales.cashCollectedMonth, 4200);
});

test('fund balance is contributions minus approved assistance payments only', () => {
  const result = summarizeAccounting({
    orders: [],
    fundMovements: [
      { type: 'contribution', status: 'posted', amount: 500 },
      { type: 'contribution', status: 'posted', amount: 250 },
      { type: 'contribution', status: 'accrued', amount: 100 },
      { type: 'bank_deposit', status: 'posted', amount: 400 },
      { type: 'assistance', status: 'posted', amount: 300 },
      { type: 'assistance', status: 'pending', amount: 1000 },
      { type: 'contribution', status: 'void', amount: 800 }
    ]
  });
  assert.equal(result.assistanceFund.contributions, 850);
  assert.equal(result.assistanceFund.deposited, 400);
  assert.equal(result.assistanceFund.pendingDeposit, 450);
  assert.equal(result.assistanceFund.assistancePaid, 300);
  assert.equal(result.assistanceFund.bookBalance, 550);
  assert.equal(result.assistanceFund.bankLedgerBalance, 100);
  assert.equal(result.assistanceFund.bankReconciled, false);
});
