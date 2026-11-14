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

function buildDeliveryIssueHistoryEntry(delivery, resolvedBy, resolution = 'reassigned', resolvedAt = new Date().toISOString()) {
  if (String(delivery?.status || '') !== 'issue') return null;
  return {
    previousCourierId: String(delivery.courierId || ''),
    previousCourierName: String(delivery.courierName || ''),
    issueReason: String(delivery.issueReason || '').slice(0, 500),
    issueAt: delivery.issueAt || null,
    issueReportedBy: String(delivery.issueReportedBy || '').toLowerCase(),
    resolution: String(resolution || 'reassigned').slice(0, 40),
    resolvedBy: String(resolvedBy || '').trim().toLowerCase(),
    resolvedAt: String(resolvedAt || new Date().toISOString())
  };
}

function hasActiveCourierDeliveries(orders) {
  return (Array.isArray(orders) ? orders : []).some(order =>
    ['assigned', 'en_camino'].includes(String(order?.delivery?.status || order?.status || ''))
  );
}

function canCourierUpdateOrderStatus(orderStatus, currentDeliveryStatus, nextDeliveryStatus) {
  if (currentDeliveryStatus === nextDeliveryStatus) return true;
  return orderStatus === 'listo' && canTransitionDeliveryStatus(currentDeliveryStatus, nextDeliveryStatus);
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
  const safeAmount = value => value !== null && value !== undefined && value !== ''
    && Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    orderId: String(orderId),
    clientName: String(order.clientName || 'Cliente'),
    address: String(order.address || ''),
    deliveryLocation: order.deliveryLocation || null,
    notes: String(order.notes || ''),
    paymentMethod: String(order.paymentMethod || 'efectivo'),
    items: Array.isArray(order.items) ? order.items.map(item => ({
      name: String(item.name || 'Producto'),
      qty: Number(item.qty) || 0,
      options: String(item.options || ''),
      description: String(item.description || '')
    })) : [],
    status: String(delivery.status || 'assigned'),
    courierId: String(delivery.courierId || ''),
    courierName: String(delivery.courierName || ''),
    routeOrder: Number(delivery.routeOrder) || 9999,
    delivery: {
      courierFee: safeAmount(delivery.courierFee),
      storeAmount: safeAmount(delivery.storeAmount),
      storeCashStatus: String(delivery.storeCashStatus || ''),
      offerAccepted: delivery.offerAccepted === true
    }
  };
}


function coordinateNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function coordinatesForOrder(order) {
  const point = order?.deliveryLocation;
  const lat = coordinateNumber(point?.lat);
  const lon = coordinateNumber(point?.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function distanceKm(a, b) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

// Nearest-neighbour ordering is a free, approximate route heuristic.
// Without a live routing provider it estimates straight-line distance, not traffic or road distance.
function hasCompleteDeliveryCoordinates(orders) {
  return Array.isArray(orders) && orders.length > 0
    && orders.every(order => coordinatesForOrder(order) !== null);
}

function optimizeDeliveryStops(orders, origin = null) {
  const remaining = (Array.isArray(orders) ? orders : []).map((order, index) => ({
    ...order,
    routeOrder: index + 1,
    _point: coordinatesForOrder(order)
  }));
  if (!remaining.length) return [];
  const allHaveCoordinates = remaining.every(order => order._point);
  if (!allHaveCoordinates) return remaining.map(({ _point, ...order }) => order);
  let current = coordinatesForOrder({ deliveryLocation: origin }) || remaining[0]._point;
  const pending = remaining.slice();
  const ordered = [];
  while (pending.length) {
    let nearestIndex = 0;
    let nearestDistance = distanceKm(current, pending[0]._point);
    for (let index = 1; index < pending.length; index++) {
      const candidateDistance = distanceKm(current, pending[index]._point);
      if (candidateDistance < nearestDistance) {
        nearestDistance = candidateDistance;
        nearestIndex = index;
      }
    }
    const [next] = pending.splice(nearestIndex, 1);
    ordered.push(next);
    current = next._point;
  }
  return ordered.map(({ _point, ...order }, index) => ({ ...order, routeOrder: index + 1 }));
}

function appendDeliveryStops(existingOrders, newOrders) {
  const existing = (Array.isArray(existingOrders) ? existingOrders : []).slice().sort((a, b) => {
    const orderA = Number(a.delivery?.routeOrder ?? a.routeOrder ?? 9999);
    const orderB = Number(b.delivery?.routeOrder ?? b.routeOrder ?? 9999);
    return orderA - orderB || String(a.orderId || '').localeCompare(String(b.orderId || ''));
  });
  const additions = optimizeDeliveryStops(newOrders);
  return [...existing, ...additions].map((order, index) => ({ ...order, routeOrder: index + 1 }));
}

function buildGoogleMapsRouteUrl(orders, origin = 'Current Location') {
  const stops = (Array.isArray(orders) ? orders : []).filter(order => String(order.address || '').trim()
    || coordinatesForOrder(order));
  if (!stops.length) return null;
  const destination = stops[stops.length - 1];
  const location = order => {
    const point = coordinatesForOrder(order);
    return point ? point.lat + ',' + point.lon : String(order.address || '').trim();
  };
  const waypoints = stops.slice(0, -1).map(location);
  const params = new URLSearchParams({
    api: '1',
    origin: String(origin || 'Current Location'),
    destination: location(destination),
    travelmode: 'driving'
  });
  if (waypoints.length) params.set('waypoints', waypoints.join('|'));
  return 'https://www.google.com/maps/dir/?' + params.toString();
}


function buildGoogleMapsRouteSegments(orders, maxStops = 4) {
  const stops = (Array.isArray(orders) ? orders : []).filter(order =>
    String(order.address || '').trim() || coordinatesForOrder(order));
  if (!stops.length) return [];
  const size = Math.max(2, Math.min(4, Number(maxStops) || 4));
  const segments = [];
  for (let offset = 0; offset < stops.length; offset += size) {
    const chunk = stops.slice(offset, offset + size);
    const previous = offset > 0 ? stops[offset - 1] : null;
    const previousPoint = previous && coordinatesForOrder(previous);
    const origin = previous
      ? (previousPoint ? previousPoint.lat + ',' + previousPoint.lon : String(previous.address || ''))
      : 'Current Location';
    segments.push({
      firstStop: offset + 1,
      lastStop: offset + chunk.length,
      url: buildGoogleMapsRouteUrl(chunk, origin)
    });
  }
  return segments;
}

function buildBatchCourierWhatsAppUrl(courier, orders, routeUrl) {
  const number = String(courier.whatsapp || '');
  if (!/^\d{8,15}$/.test(number)) throw new Error('COURIER_WHATSAPP_INVALID');
  const lines = (Array.isArray(orders) ? orders : []).map((order, index) => [
    (index + 1) + '. Pedido ' + String(order.orderId),
    'Cliente: ' + String(order.clientName || 'Cliente'),
    'Dirección: ' + String(order.address || 'No informada')
  ].join('\n'));
  const message = [
    'Ruta de reparto - Masa y Fantasías',
    'Tenés ' + lines.length + ' entregas asignadas.',
    ...lines,
    routeUrl ? 'Abrir ruta completa: ' + routeUrl : '',
    'Ingresá a Masay para actualizar cada entrega.'
  ].filter(Boolean).join('\n\n');
  return 'https://wa.me/' + number + '?text=' + encodeURIComponent(message);
}

function buildCourierWhatsAppUrl(courier, orderId, order) {
  const number = String(courier.whatsapp || '');
  if (!/^\d{8,15}$/.test(number)) throw new Error('COURIER_WHATSAPP_INVALID');
  const items = (Array.isArray(order.items) ? order.items : [])
    .map(item => '- ' + String(item.qty || 0) + ' x ' + String(item.name || 'Producto'))
    .join('\n');
  const point = coordinatesForOrder(order);
  const map = point
    ? '\nMapa: https://www.google.com/maps?q=' + encodeURIComponent(point.lat + ',' + point.lon)
    : '';
  const message = [
    'Nuevo reparto - Masa y Fantasías',
    'Pedido: ' + String(orderId),
    'Cliente: ' + String(order.clientName || 'Cliente'),
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
  canCourierUpdateOrderStatus,
  hasActiveCourierDeliveries,
  buildDeliveryIssueHistoryEntry,
  buildCourierOrder,
  hasCompleteDeliveryCoordinates,
  buildCourierWhatsAppUrl,
  optimizeDeliveryStops,
  appendDeliveryStops,
  buildGoogleMapsRouteUrl,
  buildGoogleMapsRouteSegments,
  buildBatchCourierWhatsAppUrl
};
