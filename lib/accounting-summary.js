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

  const salesFor = predicate => roundMoney(validOrders
    .filter(order => predicate(order))
    .reduce((sum, order) => sum + Math.max(0, Number(order.total) || 0), 0));

  const isPaid = order => order.paymentStatus === 'approved' || order.paymentStatus === 'cash_received';
  const orderDate = order => order.createdAt || order.paymentReceivedAt;
  const delivered = validOrders.filter(order => ['finalizado', 'entregado'].includes(String(order.status || '').toLowerCase()));

  const contributions = fundMovements.filter(m => m.type === 'contribution' && m.status === 'posted');
  const assistance = fundMovements.filter(m => m.type === 'assistance' && m.status === 'posted');
  const contributionTotal = roundMoney(contributions.reduce((sum, m) => sum + Math.max(0, Number(m.amount) || 0), 0));
  const assistanceTotal = roundMoney(assistance.reduce((sum, m) => sum + Math.max(0, Number(m.amount) || 0), 0));

  return {
    timezone: 'America/Argentina/Buenos_Aires',
    sales: {
      ordersToday: validOrders.filter(o => dateKeyInArgentina(orderDate(o)) === today).length,
      grossToday: salesFor(o => dateKeyInArgentina(orderDate(o)) === today),
      grossMonth: salesFor(o => monthKeyInArgentina(orderDate(o)) === month),
      paidToday: salesFor(o => dateKeyInArgentina(orderDate(o)) === today && isPaid(o)),
      paidMonth: salesFor(o => monthKeyInArgentina(orderDate(o)) === month && isPaid(o)),
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
