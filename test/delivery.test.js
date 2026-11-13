'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  courierDocumentId,
  normalizeCourier,
  canTransitionDeliveryStatus,
  buildCourierOrder,
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

test('delivery status only advances assigned -> on the way -> delivered', () => {
  assert.equal(canTransitionDeliveryStatus('assigned', 'en_camino'), true);
  assert.equal(canTransitionDeliveryStatus('en_camino', 'delivered'), true);
  assert.equal(canTransitionDeliveryStatus('assigned', 'delivered'), false);
  assert.equal(canTransitionDeliveryStatus('delivered', 'assigned'), false);
});

test('courier order payload contains delivery data but not payment or customer account metadata', () => {
  const payload = buildCourierOrder('order-1', {
    clientName: 'Cliente',
    clientPhone: '111',
    address: 'Calle 1',
    total: 999,
    paymentId: 'secret',
    items: [{ name: 'Torta', qty: 2, price: 400 }]
  }, { courierId: 'courier-1', courierName: 'Ana', status: 'assigned' });
  assert.deepEqual(Object.keys(payload).sort(), [
    'address', 'clientName', 'clientPhone', 'courierId', 'courierName',
    'deliveryLocation', 'items', 'notes', 'orderId', 'status'
  ].sort());
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
  assert.deepEqual(segments.map(segment => [segment.firstStop, segment.lastStop]), [[1, 10], [11, 20], [21, 23]]);
  assert.ok(segments.every(segment => segment.url.startsWith('https://www.google.com/maps/dir/')));
});

test('batch WhatsApp message contains all assigned stops and route links', () => {
  const { buildBatchCourierWhatsAppUrl } = require('../lib/delivery');
  const url = buildBatchCourierWhatsAppUrl({ whatsapp: '5491112345678' }, [
    { orderId: 'A1', clientName: 'Ana', address: 'Calle Uno' },
    { orderId: 'B2', clientName: 'Luis', address: 'Calle Dos' }
  ], 'https://www.google.com/maps/dir/?api=1');
  const message = decodeURIComponent(url.split('?text=')[1]);
  assert.match(message, /Pedido A1/);
  assert.match(message, /Pedido B2/);
  assert.match(message, /Abrir ruta completa/);
});

