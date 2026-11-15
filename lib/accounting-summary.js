'use strict';

const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function validDate(value) {
  if (value && typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateKeyInArgentina(value) {
  const date = validDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function monthKeyInArgentina(value) {
  const key = dateKeyInArgentina(value);
  return key ? key.slice(0, 7) : null;
}

function summarizeAccounting({ orders = [], fundMovements = [], now = new Date() } = {}) {
  const today = dateKeyInArgentina(now);
  const month = monthKeyInArgentina(now);
  const validOrders = orders.filter(order => order && order.esPrueba !== true
    && order.testType !== 'audio' && order.paymentMethod !== 'prueba');

  const amountFor = (rows, predicate) => roundMoney(rows
    .filter(predicate)
    .reduce((sum, order) => sum + Math.max(0, Number(order.total) || 0), 0));

  // These values match the production checkout/webhook schema:
  // efectivo + cash_received, and mercadopago + approved.
  const isCash = order => ['efectivo', 'cash'].includes(String(order.paymentMethod || '').toLowerCase());
  const isOnline = order => String(order.paymentMethod || '').toLowerCase() === 'mercadopago';
  const isCashPaid = order => isCash(order) && order.paymentStatus === 'cash_received';
  const isOnlinePaid = order => isOnline(order) && order.paymentStatus === 'approved';
  const isPaid = order => isCashPaid(order) || isOnlinePaid(order);
  const salesDate = order => order.createdAt;
  const paymentDate = order => isCashPaid(order) ? (order.paymentReceivedAt || order.createdAt) : order.createdAt;
  const todaySales = order => dateKeyInArgentina(salesDate(order)) === today;
  const monthSales = order => monthKeyInArgentina(salesDate(order)) === month;
  const todayPayment = order => dateKeyInArgentina(paymentDate(order)) === today && isPaid(order);
  const monthPayment = order => monthKeyInArgentina(paymentDate(order)) === month && isPaid(order);
  const delivered = validOrders.filter(order => ['finalizado', 'entregado'].includes(String(order.status || '').toLowerCase()));

  const contributions = fundMovements.filter(m => m.type === 'contribution' && m.status === 'posted');
  const assistance = fundMovements.filter(m => m.type === 'assistance' && m.status === 'posted');
  const contributionTotal = roundMoney(contributions.reduce((sum, m) => sum + Math.max(0, Number(m.amount) || 0), 0));
  const assistanceTotal = roundMoney(assistance.reduce((sum, m) => sum + Math.max(0, Number(m.amount) || 0), 0));

  const cashToday = amountFor(validOrders, order => todayPayment(order) && isCashPaid(order));
  const onlineToday = amountFor(validOrders, order => todayPayment(order) && isOnlinePaid(order));
  const cashMonth = amountFor(validOrders, order => monthPayment(order) && isCashPaid(order));
  const onlineMonth = amountFor(validOrders, order => monthPayment(order) && isOnlinePaid(order));

  return {
    timezone: 'America/Argentina/Buenos_Aires',
    sales: {
      ordersToday: validOrders.filter(todaySales).length,
      grossToday: amountFor(validOrders, todaySales),
      grossMonth: amountFor(validOrders, monthSales),
      cashCollectedToday: cashToday,
      onlineCollectedToday: onlineToday,
      totalCollectedToday: roundMoney(cashToday + onlineToday),
      cashCollectedMonth: cashMonth,
      onlineCollectedMonth: onlineMonth,
      totalCollectedMonth: roundMoney(cashMonth + onlineMonth),
      pendingCollectionToday: amountFor(validOrders, order => todaySales(order) && order.paymentStatus === 'pending'),
      pendingCollectionMonth: amountFor(validOrders, order => monthSales(order) && order.paymentStatus === 'pending'),
      deliveredOrders: delivered.length
    },
    assistanceFund: {
      contributions: contributionTotal,
      assistancePaid: assistanceTotal,
      bookBalance: roundMoney(contributionTotal - assistanceTotal),
      contributionCount: contributions.length,
      assistanceCount: assistance.length,
      bankReconciled: false
    }
  };
}

module.exports = { summarizeAccounting, dateKeyInArgentina, monthKeyInArgentina };
