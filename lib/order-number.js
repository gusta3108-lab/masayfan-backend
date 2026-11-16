'use strict';

function nextOrderSequence(currentCounter, existingOrders = []) {
  const counter = Number.isSafeInteger(Number(currentCounter)) && Number(currentCounter) > 0
    ? Number(currentCounter) : 0;
  const orders = Array.isArray(existingOrders) ? existingOrders.filter(order => order && order.esPrueba !== true) : [];
  const maxExisting = orders.reduce((max, order) => {
    const raw = String(order.publicOrderNumber || order.displayOrderNumber || '');
    if (!/^\d{1,12}$/.test(raw)) return max;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? Math.max(max, value) : max;
  }, 0);
  return Math.max(counter, maxExisting, counter === 0 ? orders.length : 0) + 1;
}

function formatPublicOrderNumber(sequence) {
  const value = Number(sequence);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('ORDER_SEQUENCE_INVALID');
  return String(value).padStart(4, '0');
}

module.exports = { nextOrderSequence, formatPublicOrderNumber };
