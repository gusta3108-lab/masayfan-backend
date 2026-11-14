'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  courierDocumentId,
  normalizeCourier,
  canTransitionDeliveryStatus,
  canCourierUpdateOrderStatus,
  hasActiveCourierDeliveries,
  buildCourierOrder,
  hasCompleteDeliveryCoordinates,
  buildCourierWhatsAppUrl
} = require('../lib/delivery');

test('courier identity is normalized and does not expose email as document id', () => {
  const id = courierDocumentId(' Repartidor@Example.com ');
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(id, courierDocumentId('repartidor@example.com'));
  assert.throws(() => courierDocumentId('invalid'), /COURIER_EMAIL_INVALID/);
});

test('courier profile validates contact data and international WhatsApp number', () => {
  assert.deepEqual(normalizeCourier({
    name: '  Ana   Pérez ',
    email: ' ANA@example.com ',
    phone: '+54 11 1234-5678',
    whatsapp: '+54 9 11 1234-5678'
  }), {
    name: 'Ana Pérez',
    email: 'ana@example.com',
    phone: '+54 11 1234-5678',
    whatsapp: '5491112345678'
  });
  assert.throws(() => normalizeCourier({ name: 'A', email: 'a@b.com', phone: '123456', whatsapp: '12345678' }), /COURIER_NAME_INVALID/);
  assert.throws(() => normalizeCourier({ name: 'Ana', email: 'a@b.com', phone: '123456', whatsapp: '123' }), /COURIER_WHATSAPP_INVALID/);
});

test('courier order view includes the accepted fee and cash handoff state', () => {
  const result = buildCourierOrder('order-1', {
    clientName: 'Ana',
    paymentMethod: 'efectivo',
    total: 20000,
    items: []
  }, {
    courierId: 'courier-1',
    courierFee: 4000,
    storeAmount: 16000,
    storeCashStatus: 'received',
    offerAccepted: true,
    status: 'assigned',
    routeOrder: 1
  });
  assert.equal(result.paymentMethod, 'efectivo');
  assert.equal(result.delivery.courierFee, 4000);
  assert.equal(result.delivery.storeAmount, 16000);
  assert.equal(result.delivery.storeCashStatus, 'received');
  assert.equal(result.delivery.offerAccepted, true);
  const missing = buildCourierOrder('order-2', {}, {});
  assert.equal(missing.delivery.courierFee, null);
  assert.equal(missing.delivery.storeCashStatus, '');
});

test('delivery status only advances assigned -> on the way -> delivered', () => {
  assert.equal(canTransitionDeliveryStatus('assigned', 'en_camino'), true);
  assert.equal(canTransitionDeliveryStatus('en_camino', 'delivered'), true);
  assert.equal(canTransitionDeliveryStatus('assigned', 'delivered'), false);
  assert.equal(canTransitionDeliveryStatus('delivered', 'assigned'), false);
});

test('courier cannot advance delivery after an order leaves the ready state; repeated status is idempotent', () => {
  assert.equal(canCourierUpdateOrderStatus('listo', 'assigned', 'en_camino'), true);
  assert.equal(canCourierUpdateOrderStatus('listo', 'en_camino', 'delivered'), true);
  assert.equal(canCourierUpdateOrderStatus('cancelado', 'assigned', 'en_camino'), false);
  assert.equal(canCourierUpdateOrderStatus('rechazado', 'en_camino', 'delivered'), false);
  assert.equal(canCourierUpdateOrderStatus('finalizado', 'delivered', 'delivered'), true);
});

test('courier cannot be deactivated while active deliveries remain assigned', () => {
  assert.equal(hasActiveCourierDeliveries([{ delivery: { status: 'assigned' } }]), true);
  assert.equal(hasActiveCourierDeliveries([{ delivery: { status: 'en_camino' } }]), true);
  assert.equal(hasActiveCourierDeliveries([{ delivery: { status: 'delivered' } }]), false);
  assert.equal(hasActiveCourierDeliveries([]), false);
});

test('courier order payload exposes only payment method and accepted delivery amounts, not customer account metadata', () => {
  const payload = buildCourierOrder('order-1', {
    clientName: 'Cliente',
    clientPhone: '111',
    address: 'Calle 1',
    total: 999,
    paymentMethod: 'efectivo',
    paymentId: 'secret',
    customerBankAccount: 'secret-account',
    items: [{ name: 'Torta', qty: 2, price: 400 }]
  }, {
    courierId: 'courier-1', courierName: 'Ana', status: 'assigned',
    courierFee: 250, storeAmount: 749, storeCashStatus: 'received', offerAccepted: true
  });
  assert.deepEqual(Object.keys(payload).sort(), [
    'address', 'clientName', 'courierId', 'courierName',
    'delivery', 'deliveryLocation', 'items', 'notes', 'orderId', 'paymentMethod', 'routeOrder', 'status'
  ].sort());
  assert.equal(Object.hasOwn(payload, 'clientPhone'), false, 'courier payload must not expose customer phone');
  assert.equal(payload.paymentMethod, 'efectivo');
  assert.deepEqual(payload.delivery, {
    courierFee: 250, storeAmount: 749, storeCashStatus: 'received', offerAccepted: true
  });
  assert.equal(payload.paymentId, undefined);
  assert.equal(payload.customerBankAccount, undefined);
  assert.equal(payload.items[0].name, 'Torta');
});

test('WhatsApp link addresses only the courier and URL-encodes order details', () => {
  const url = buildCourierWhatsAppUrl({ whatsapp: '5491112345678' }, 'order-1', {
    clientName: 'María',
    clientPhone: '112233',
    address: 'Av. Siempre Viva 123',
    deliveryLocation: { lat: -34.6, lon: -58.4 },
    items: [{ name: 'Torta', qty: 2 }]
  });
  assert.match(url, /^https:\/\/wa\.me\/5491112345678\?text=/);
  const message = decodeURIComponent(url.split('?text=')[1]);
  assert.match(message, /María/);
  assert.match(message, /Av\. Siempre Viva 123/);
  assert.match(message, /google\.com\/maps/);
  assert.doesNotMatch(message, /Teléfono:|112233/);
});

test('WhatsApp map link omits null coordinates instead of routing to zero coordinates', () => {
  const url = buildCourierWhatsAppUrl({ whatsapp: '5491112345678' }, 'order-null-coords', {
    address: 'Calle sin geolocalizar',
    deliveryLocation: { lat: null, lon: null },
    items: []
  });
  const message = decodeURIComponent(url.split('?text=')[1]);
  assert.doesNotMatch(message, /google\.com\/maps/);
  assert.match(message, /Calle sin geolocalizar/);
});

test('delivery route is optimized by nearest straight-line stop when all addresses have coordinates', () => {
  const { optimizeDeliveryStops, buildGoogleMapsRouteUrl, buildGoogleMapsRouteSegments } = require('../lib/delivery');
  const orders = [
    { orderId: 'far', address: 'Far', deliveryLocation: { lat: -34.7, lon: -58.6 } },
    { orderId: 'near', address: 'Near', deliveryLocation: { lat: -34.61, lon: -58.41 } },
    { orderId: 'middle', address: 'Middle', deliveryLocation: { lat: -34.65, lon: -58.5 } }
  ];
  const optimized = optimizeDeliveryStops(orders, { lat: -34.6, lon: -58.4 });
  assert.deepEqual(optimized.map(order => order.orderId), ['near', 'middle', 'far']);
  assert.deepEqual(optimized.map(order => order.routeOrder), [1, 2, 3]);
  assert.match(buildGoogleMapsRouteUrl(optimized), /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1/);
  assert.equal(buildGoogleMapsRouteSegments(optimized).length, 1);
});

test('route optimization reports when any stop lacks valid coordinates', () => {
  assert.equal(hasCompleteDeliveryCoordinates([
    { deliveryLocation: { lat: -34.6, lon: -58.4 } },
    { deliveryLocation: { lat: -34.7, lon: -58.5 } }
  ]), true);
  assert.equal(hasCompleteDeliveryCoordinates([
    { deliveryLocation: { lat: -34.6, lon: -58.4 } },
    { address: 'Sin coordenadas' }
  ]), false);
  assert.equal(hasCompleteDeliveryCoordinates([]), false);
  assert.equal(hasCompleteDeliveryCoordinates([
    { deliveryLocation: { lat: '', lon: '' } }
  ]), false);
  assert.equal(hasCompleteDeliveryCoordinates([
    { deliveryLocation: { lat: null, lon: -58.4 } }
  ]), false);
  assert.equal(hasCompleteDeliveryCoordinates([
    { deliveryLocation: { lat: ' ', lon: '-58.4' } }
  ]), false);
});

test('new courier batches append after existing active stops with unique route positions', () => {
  const { appendDeliveryStops } = require('../lib/delivery');
  const existing = [
    { orderId: 'existing-2', delivery: { routeOrder: 2 } },
    { orderId: 'existing-1', delivery: { routeOrder: 1 } }
  ];
  const additions = [
    { orderId: 'new-far', deliveryLocation: { lat: -34.7, lon: -58.6 } },
    { orderId: 'new-near', deliveryLocation: { lat: -34.61, lon: -58.41 } }
  ];
  const route = appendDeliveryStops(existing, additions);
  assert.deepEqual(route.map(order => order.orderId), ['existing-1', 'existing-2', 'new-far', 'new-near']);
  assert.deepEqual(route.map(order => order.routeOrder), [1, 2, 3, 4]);
});

test('route planning preserves selected order when coordinates are incomplete and splits large routes', () => {
  const { optimizeDeliveryStops, buildGoogleMapsRouteSegments } = require('../lib/delivery');
  const withoutCoordinates = optimizeDeliveryStops([
    { orderId: 'a', address: 'Calle A' },
    { orderId: 'b', address: 'Calle B', deliveryLocation: { lat: -34.6, lon: -58.4 } }
  ]);
  assert.deepEqual(withoutCoordinates.map(order => order.orderId), ['a', 'b']);
  const orders = Array.from({ length: 23 }, (_, index) => ({
    orderId: String(index + 1),
    address: 'Calle ' + (index + 1),
    deliveryLocation: { lat: -34.6 + index / 100, lon: -58.4 + index / 100 }
  }));
  const segments = buildGoogleMapsRouteSegments(orders);
  assert.deepEqual(segments.map(segment => [segment.firstStop, segment.lastStop]), [[1, 4], [5, 8], [9, 12], [13, 16], [17, 20], [21, 23]]);
  assert.ok(segments.every(segment => segment.url.startsWith('https://www.google.com/maps/dir/')));
});

test('batch WhatsApp message contains all assigned stops and route links', () => {
  const { buildBatchCourierWhatsAppUrl } = require('../lib/delivery');
  const url = buildBatchCourierWhatsAppUrl({ whatsapp: '5491112345678' }, [
    { orderId: 'A1', clientName: 'Ana', clientPhone: '5491100011111', address: 'Calle Uno' },
    { orderId: 'B2', clientName: 'Luis', address: 'Calle Dos' }
  ], 'https://www.google.com/maps/dir/?api=1');
  const message = decodeURIComponent(url.split('?text=')[1]);
  assert.match(message, /Pedido A1/);
  assert.match(message, /Pedido B2/);
  assert.match(message, /Abrir ruta completa/);
  assert.doesNotMatch(message, /Teléfono:|5491100011111/);
});

