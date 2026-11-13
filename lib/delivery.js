'use strict';

const crypto = require('node:crypto');

const DELIVERY_STATUSES = Object.freeze(['assigned', 'en_camino', 'delivered']);

function courierDocumentId(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) {
    throw new Error('COURIER_EMAIL_INVALID');
  }
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function normalizeCourier(input = {}) {
  const name = String(input.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const email = String(input.email || '').trim().toLowerCase();
  const phone = String(input.phone || '').trim().slice(0, 40);
  const whatsapp = String(input.whatsapp || '').replace(/[^0-9]/g, '');
  if (name.length < 2) throw new Error('COURIER_NAME_INVALID');
  courierDocumentId(email);
  if (!phone || phone.replace(/\D/g, '').length < 6) throw new Error('COURIER_PHONE_INVALID');
  // wa.me requiere el número internacional, sin +, espacios ni signos.
  if (whatsapp.length < 8 || whatsapp.length > 15 || whatsapp.startsWith('0')) {
    throw new Error('COURIER_WHATSAPP_INVALID');
  }
  return { name, email, phone, whatsapp };
}

function canTransitionDeliveryStatus(current, next) {
  const allowed = {
    assigned: ['en_camino'],
    en_camino: ['delivered'],
    delivered: []
  };
  return current === next || Boolean(allowed[current]?.includes(next));
}

function buildCourierOrder(orderId, order, delivery) {
  return {
    orderId: String(orderId),
    clientName: String(order.clientName || 'Cliente'),
    clientPhone: String(order.clientPhone || ''),
    address: String(order.address || ''),
    deliveryLocation: order.deliveryLocation || null,
    notes: String(order.notes || ''),
    items: Array.isArray(order.items) ? order.items.map(item => ({
      name: String(item.name || 'Producto'),
      qty: Number(item.qty) || 0,
      options: String(item.options || ''),
      description: String(item.description || '')
    })) : [],
    status: String(delivery.status || 'assigned'),
    courierId: String(delivery.courierId || ''),
    courierName: String(delivery.courierName || '')
  };
}

function buildCourierWhatsAppUrl(courier, orderId, order) {
  const number = String(courier.whatsapp || '');
  if (!/^\d{8,15}$/.test(number)) throw new Error('COURIER_WHATSAPP_INVALID');
  const items = (Array.isArray(order.items) ? order.items : [])
    .map(item => '- ' + String(item.qty || 0) + ' x ' + String(item.name || 'Producto'))
    .join('\n');
  const map = order.deliveryLocation
    && Number.isFinite(Number(order.deliveryLocation.lat))
    && Number.isFinite(Number(order.deliveryLocation.lon))
    ? '\nMapa: https://www.google.com/maps?q=' + encodeURIComponent(order.deliveryLocation.lat + ',' + order.deliveryLocation.lon)
    : '';
  const message = [
    'Nuevo reparto - Masa y Fantasías',
    'Pedido: ' + String(orderId),
    'Cliente: ' + String(order.clientName || 'Cliente'),
    'Teléfono: ' + String(order.clientPhone || 'No informado'),
    'Dirección: ' + String(order.address || 'No informada'),
    items ? 'Detalle:\n' + items : '',
    order.notes ? 'Observaciones: ' + String(order.notes) : '',
    map,
    'Ingresá a Masay para actualizar el estado de la entrega.'
  ].filter(Boolean).join('\n');
  return 'https://wa.me/' + number + '?text=' + encodeURIComponent(message);
}

module.exports = {
  DELIVERY_STATUSES,
  courierDocumentId,
  normalizeCourier,
  canTransitionDeliveryStatus,
  buildCourierOrder,
  buildCourierWhatsAppUrl
};
