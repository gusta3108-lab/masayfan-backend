'use strict';

const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function buildCourierEarning(order, courierFee) {
  const total = roundMoney(order?.total);
  const fee = roundMoney(courierFee);
  if (!Number.isFinite(total) || total <= 0) throw new Error('ORDER_TOTAL_INVALID');
  if (!Number.isFinite(fee) || fee < 0 || fee > total) throw new Error('COURIER_FEE_INVALID');

  const paymentMethod = String(order?.paymentMethod || 'efectivo').trim().toLowerCase();
  const isCash = ['efectivo', 'cash'].includes(paymentMethod);
  return {
    total,
    courierFee: fee,
    storeAmount: roundMoney(total - fee),
    paymentMethod: isCash ? 'efectivo' : paymentMethod,
    earningStatus: isCash ? 'cash_received' : 'online_pending'
  };
}

function summarizeCourierWallet(movements, payouts = []) {
  const entries = Array.isArray(movements) ? movements : [];
  const payments = Array.isArray(payouts) ? payouts : [];
  const totalEarned = roundMoney(entries.reduce((sum, entry) => sum + Math.max(0, Number(entry.amount) || 0), 0));
  const cashReceived = roundMoney(entries
    .filter(entry => entry.status === 'cash_received')
    .reduce((sum, entry) => sum + Math.max(0, Number(entry.amount) || 0), 0));
  const onlineEarned = roundMoney(entries
    .filter(entry => entry.status === 'online_pending' || entry.status === 'paid')
    .reduce((sum, entry) => sum + Math.max(0, Number(entry.amount) || 0), 0));
  const paidOut = roundMoney(payments
    .filter(payment => payment.status === 'paid')
    .reduce((sum, payment) => sum + Math.max(0, Number(payment.amount) || 0), 0));
  const balanceToPay = roundMoney(Math.max(0, totalEarned - cashReceived - paidOut));
  return { totalEarned, cashReceived, onlineEarned, paidOut, balanceToPay };
}

module.exports = { buildCourierEarning, summarizeCourierWallet };
