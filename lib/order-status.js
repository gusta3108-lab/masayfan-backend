'use strict';

const NEXT_STATUSES = Object.freeze({
  nuevo: Object.freeze(['preparacion', 'rechazado']),
  aceptado: Object.freeze(['listo', 'rechazado']),
  preparacion: Object.freeze(['listo', 'rechazado']),
  listo: Object.freeze(['finalizado', 'rechazado']),
  finalizado: Object.freeze([]),
  rechazado: Object.freeze([])
});

function canTransitionOrderStatus(currentStatus, nextStatus) {
  const current = String(currentStatus || 'nuevo');
  const next = String(nextStatus || '');
  if (current === next) return true;
  return (NEXT_STATUSES[current] || []).includes(next);
}

function canRejectOrder(order = {}) {
  return order.paymentMethod !== 'mercadopago' || order.paymentStatus === 'refunded';
}

module.exports = { canTransitionOrderStatus, canRejectOrder };
