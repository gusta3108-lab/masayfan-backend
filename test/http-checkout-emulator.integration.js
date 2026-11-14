'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error('Estas pruebas requieren Firestore y Auth Emulator; se bloquea cualquier conexión a producción.');
}

// La app valida el project_id, pero los emuladores aceptan esta identidad local
// sin credenciales reales. Ninguna clave ni token de producción se utiliza.
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'masayfantasias',
  private_key_id: 'local-emulator-only',
  private_key: privateKey,
  client_email: 'masay-emulator@masayfantasias.iam.gserviceaccount.com',
  client_id: '1',
  token_uri: 'https://oauth2.googleapis.com/token'
});
process.env.MP_ACCESS_TOKEN = 'TEST-ONLY-NOT-A-REAL-MERCADO-PAGO-TOKEN';
process.env.MP_WEBHOOK_SECRET = 'local-emulator-webhook-secret';

globalThis.__masayMockPreference = null;
globalThis.__masayMockPreferenceCalls = 0;
globalThis.__masayMockPayment = null;
globalThis.__masayMockPaymentFetches = 0;

class MercadoPagoConfig {
  constructor() {}
}
class Preference {
  async create({ body }) {
    globalThis.__masayMockPreferenceCalls += 1;
    globalThis.__masayMockPreference = body;
    return { id: 'pref-emulator-001', init_point: 'https://sandbox.invalid/checkout/emulator' };
  }
}
class Payment {
  async get() {
    globalThis.__masayMockPaymentFetches += 1;
    if (!globalThis.__masayMockPayment) throw new Error('No se configuró el pago simulado.');
    return globalThis.__masayMockPayment;
  }
}
const realMercadoPago = require('mercadopago');
const mpPath = require.resolve('mercadopago');
require.cache[mpPath] = {
  id: mpPath,
  filename: mpPath,
  loaded: true,
  exports: {
    MercadoPagoConfig,
    Preference,
    Payment,
    WebhookSignatureValidator: realMercadoPago.WebhookSignatureValidator,
    InvalidWebhookSignatureError: realMercadoPago.InvalidWebhookSignatureError
  }
};

const app = require('../server');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const firestore = getFirestore();
const { randomUUID } = crypto;

function signedWebhookHeaders(dataId, requestId, secret) {
  const ts = String(Math.floor(Date.now() / 1000));
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const signature = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return {
    'x-signature': `ts=${ts},v1=${signature}`,
    'x-request-id': requestId
  };
}

let server;
let baseUrl;
let idToken;
let userUid;
let customerEmail = null;
let adminEmail = null;
let adminIdToken = null;
const productId = 'http-checkout-' + randomUUID();
const raceProductId = 'http-race-' + randomUUID();
const noStockProductId = 'http-no-stock-' + randomUUID();
const restoreProductId = 'http-restore-' + randomUUID();
const refundOrderId = 'http-refund-order-' + randomUUID();
let raceOrderId = null;
let raceExternalReference = null;

test('HTTP efectivo y Mercado Pago simulado completan compras sin tocar producción', async t => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = 'http://127.0.0.1:' + server.address().port;

  const email = 'checkout-' + randomUUID() + '@example.test';
  customerEmail = email;
  const signup = await fetch(
    'http://' + process.env.FIREBASE_AUTH_EMULATOR_HOST +
      '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-api-key',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'EmulatorPass123!', returnSecureToken: true })
    }
  );
  assert.equal(signup.status, 200, 'Auth Emulator debe crear el usuario de prueba');
  const authData = await signup.json();
  idToken = authData.idToken;
  userUid = authData.localId;

  adminEmail = 'admin-' + randomUUID() + '@example.test';
  const adminSignup = await fetch(
    'http://' + process.env.FIREBASE_AUTH_EMULATOR_HOST +
      '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-api-key',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: 'EmulatorPass123!', returnSecureToken: true })
    }
  );
  assert.equal(adminSignup.status, 200, 'Auth Emulator debe crear el administrador de prueba');
  const adminSignupData = await adminSignup.json();
  const { getAuth } = require('firebase-admin/auth');
  await getAuth().updateUser(adminSignupData.localId, { emailVerified: true });
  const adminSignIn = await fetch(
    'http://' + process.env.FIREBASE_AUTH_EMULATOR_HOST +
      '/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-api-key',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: 'EmulatorPass123!', returnSecureToken: true })
    }
  );
  assert.equal(adminSignIn.status, 200, 'Auth Emulator debe emitir un token para el administrador verificado');
  adminIdToken = (await adminSignIn.json()).idToken;
  const verifiedAdminToken = await getAuth().verifyIdToken(adminIdToken);
  assert.equal(verifiedAdminToken.email_verified, true, 'El token administrativo debe incluir email_verified=true');

  await firestore.collection('productos').doc(productId).set({
    name: 'Producto HTTP de prueba',
    price: 100,
    activo: true,
  });

  const headers = {
    authorization: 'Bearer ' + idToken,
    'content-type': 'application/json'
  };
  const order = {
    clientName: 'Cliente de prueba',
    clientPhone: '1111111111',
    address: 'Dirección de prueba',
    notes: 'Solo emulador',
    deliveryLocation: { lat: -34.7001, lon: -58.3952 }
  };
  const items = [{ id: productId, qty: 1, price: 100, options: '' }];

  await t.test('rechaza coordenadas de entrega fuera de rango', async () => {
    const response = await fetch(baseUrl + '/api/pedidos/efectivo', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ items, order: { ...order, deliveryLocation: { lat: 91, lon: -58.4 } } })
    });
    const body = await response.json();
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match(body.error, /ubicación del mapa no es válida/i);
    const product = (await firestore.collection('productos').doc(productId).get()).data();
  });

  await t.test('el checkout en efectivo crea el pedido sin modificar inventario', async () => {
    const key = randomUUID();
    const response = await fetch(baseUrl + '/api/pedidos/efectivo', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': key },
      body: JSON.stringify({ items, order })
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.success, true);
    const savedOrder = await firestore.collection('pedidos').doc(body.order_id).get();
    assert.equal(savedOrder.exists, true);
    assert.equal(savedOrder.data().paymentMethod, 'efectivo');
    assert.equal(savedOrder.data().uid, userUid);
    assert.deepEqual(savedOrder.data().deliveryLocation, order.deliveryLocation, 'el pedido debe conservar las coordenadas seleccionadas en el mapa');
    let product = (await firestore.collection('productos').doc(productId).get()).data();

    const replay = await fetch(baseUrl + '/api/pedidos/efectivo', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': key },
      body: JSON.stringify({ items, order })
    });
    const replayBody = await replay.json();
    assert.equal(replay.status, 200, JSON.stringify(replayBody));
    assert.equal(replayBody.replayed, true);
    assert.equal(replayBody.order_id, body.order_id);
    product = (await firestore.collection('productos').doc(productId).get()).data();

    const crossMethodReuse = await fetch(baseUrl + '/api/crear-preferencia', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': key },
      body: JSON.stringify({ items, order })
    });
    const crossMethodBody = await crossMethodReuse.json();
    assert.equal(crossMethodReuse.status, 409, JSON.stringify(crossMethodBody));
    assert.match(crossMethodBody.error, /intento de compra ya fue utilizado/i);
    product = (await firestore.collection('productos').doc(productId).get()).data();
  });

  await t.test('un producto desactivado manualmente no puede generar un checkout', async () => {
    await firestore.collection('productos').doc(noStockProductId).set({ name: 'Producto pausado de prueba', price: 100, activo: false });
    const preferenceCallsBefore = globalThis.__masayMockPreferenceCalls;
    const response = await fetch(baseUrl + '/api/crear-preferencia', {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ items: [{ id: noStockProductId, qty: 1, price: 100, options: '' }], order })
    });
    const body = await response.json();
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match(body.error, /no está disponible/i);
    assert.equal(globalThis.__masayMockPreferenceCalls, preferenceCallsBefore, 'un producto desactivado no debe llegar a Mercado Pago');
  });

  await t.test('Mercado Pago crea el checkout y el webhook simulado registra una sola orden y el webhook simulado confirma una sola venta', async () => {
    const mpIdempotencyKey = randomUUID();
    const response = await fetch(baseUrl + '/api/crear-preferencia', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': mpIdempotencyKey },
      body: JSON.stringify({ items, order })
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    assert.equal(body.init_point, 'https://sandbox.invalid/checkout/emulator');
    assert.equal(globalThis.__masayMockPreference.external_reference, body.external_reference);

    const replay = await fetch(baseUrl + '/api/crear-preferencia', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': mpIdempotencyKey },
      body: JSON.stringify({ items, order })
    });
    const replayBody = await replay.json();
    assert.equal(replay.status, 200, JSON.stringify(replayBody));
    assert.equal(replayBody.replayed, true);
    assert.equal(replayBody.external_reference, body.external_reference);
    assert.equal(replayBody.init_point, body.init_point);

    let product = (await firestore.collection('productos').doc(productId).get()).data();
    const pendingCheckout = (await firestore.collection('pagos_pendientes').doc(body.external_reference).get()).data();
    assert.deepEqual(pendingCheckout.order.deliveryLocation, order.deliveryLocation, 'el checkout de Mercado Pago debe conservar las coordenadas');

    globalThis.__masayMockPayment = {
      id: '987654321',
      status: 'approved',
      external_reference: body.external_reference,
      currency_id: 'ARS',
      transaction_amount: 100,
      preference_id: 'pref-emulator-001',
      metadata: { user_uid: userUid }
    };

    const webhookUrl = baseUrl + '/api/webhook?type=payment&data.id=987654321';
    const webhookBody = JSON.stringify({ type: 'payment', data: { id: '987654321' } });
    const invalidSignature = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': `ts=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
        'x-request-id': 'emulator-invalid-signature'
      },
      body: webhookBody
    });
    assert.equal(invalidSignature.status, 401);
    assert.equal(globalThis.__masayMockPaymentFetches, 0, 'una firma inválida no debe consultar ni procesar el pago');

    // Una firma válida no basta: el importe debe coincidir con la orden pendiente.
    globalThis.__masayMockPayment.transaction_amount = 99;
    const mismatchedAmount = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signedWebhookHeaders('987654321', 'emulator-wrong-amount', process.env.MP_WEBHOOK_SECRET)
      },
      body: webhookBody
    });
    assert.equal(mismatchedAmount.status, 200, 'un pago aprobado inconsistente queda registrado para revisión, sin reintentos infinitos');
    assert.equal(globalThis.__masayMockPaymentFetches, 1);
    const pendingAfterMismatch = await firestore.collection('pagos_pendientes').doc(body.external_reference).get();
    assert.equal(pendingAfterMismatch.exists, true, 'un importe incorrecto no debe cerrar la orden pendiente');
    assert.equal(pendingAfterMismatch.data().paymentApprovedNeedsReview, true);
    const validationIncidentId = body.external_reference + '_987654321';
    const validationIncident = await firestore.collection('incidencias_pagos').doc(validationIncidentId).get();
    assert.equal(validationIncident.exists, true, 'el pago aprobado con importe incorrecto debe quedar visible para administración');
    assert.equal(validationIncident.data().status, 'needs_admin_review');
    product = (await firestore.collection('productos').doc(productId).get()).data();

    globalThis.__masayMockPayment.transaction_amount = 100;
    // Si Mercado Pago sí informa preference_id, una discrepancia real se rechaza.
    globalThis.__masayMockPayment.preference_id = 'pref-emulator-different';
    const mismatchedPreference = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signedWebhookHeaders('987654321', 'emulator-wrong-preference', process.env.MP_WEBHOOK_SECRET)
      },
      body: webhookBody
    });
    assert.equal(mismatchedPreference.status, 200);
    const preferenceIncident = await firestore.collection('incidencias_pagos').doc(validationIncidentId).get();
    assert.equal(preferenceIncident.data().reason, 'La preferencia del pago no coincide con el pedido.');
    assert.equal((await firestore.collection('pedidos').doc(body.external_reference).get()).exists, false);

    // Mercado Pago puede omitir preference_id en Payment; la referencia
    // externa única, el importe, la moneda y metadata.uid siguen verificándose.
    delete globalThis.__masayMockPayment.preference_id;
    const webhook = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signedWebhookHeaders('987654321', 'emulator-request-1', process.env.MP_WEBHOOK_SECRET)
      },
      body: webhookBody
    });
    assert.equal(webhook.status, 200);
    assert.equal(globalThis.__masayMockPaymentFetches, 3);

    const savedOrder = await firestore.collection('pedidos').doc(body.external_reference).get();
    assert.equal(savedOrder.exists, true);
    assert.equal(savedOrder.data().paymentMethod, 'mercadopago');
    assert.equal(savedOrder.data().paymentStatus, 'approved');
    assert.equal(savedOrder.data().paymentId, '987654321');
    assert.equal(
      (await firestore.collection('pagos_pendientes').doc(body.external_reference).get()).exists,
      false
    );

    product = (await firestore.collection('productos').doc(productId).get()).data();

    // Repetir el webhook no debe crear otro pedido.
    const duplicate = await fetch(
      webhookUrl,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedWebhookHeaders('987654321', 'emulator-request-2', process.env.MP_WEBHOOK_SECRET)
        },
        body: JSON.stringify({ type: 'payment', data: { id: '987654321' } })
      }
    );
    assert.equal(duplicate.status, 200);
    assert.equal(globalThis.__masayMockPaymentFetches, 4, 'cada webhook consulta el pago una sola vez');
    assert.equal((await firestore.collection('incidencias_pagos').doc(validationIncidentId).get()).exists, false, 'la incidencia se cierra cuando el pago se valida y registra correctamente');
    product = (await firestore.collection('productos').doc(productId).get()).data();
  });

  await t.test('dos checkouts simultáneos no se bloquean por cantidades de inventario', async () => {
    await firestore.collection('productos').doc(raceProductId).set({ name: 'Producto de concurrencia HTTP', price: 100, activo: true });
    const raceItems = [{ id: raceProductId, qty: 1, price: 100, options: '' }];
    const [cashResponse, mpResponse] = await Promise.all([
      fetch(baseUrl + '/api/pedidos/efectivo', { method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ items: raceItems, order }) }),
      fetch(baseUrl + '/api/crear-preferencia', { method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ items: raceItems, order }) })
    ]);
    const [cashBody, mpBody] = await Promise.all([cashResponse.json(), mpResponse.json()]);
    assert.equal(cashResponse.status, 201, JSON.stringify(cashBody));
    assert.equal(mpResponse.status, 200, JSON.stringify(mpBody));
    raceOrderId = cashBody.order_id;
    raceExternalReference = mpBody.external_reference;
    assert.ok((await firestore.collection('pedidos').doc(raceOrderId).get()).exists);
    assert.ok((await firestore.collection('pagos_pendientes').doc(raceExternalReference).get()).exists);
  });

  await t.test('el rechazo de un pago Mercado Pago exige devolución', async () => {
    await firestore.collection('pedidos').doc(refundOrderId).set({
      items: [{ qty: 1 }],
      status: 'nuevo',
      paymentMethod: 'mercadopago',
      paymentStatus: 'approved',
    });
    await firestore.collection('administradores').doc(adminEmail).set({ enabled: true });

    const endpoint = baseUrl + '/api/admin/orders/' + refundOrderId + '/status';
    const adminHeaders = { ...headers, 'content-type': 'application/json' };
    const beforeRefund = await fetch(endpoint, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ status: 'rechazado' })
    });
    const beforeRefundBody = await beforeRefund.json();
    assert.equal(beforeRefund.status, 409, JSON.stringify(beforeRefundBody));

    await firestore.collection('pedidos').doc(refundOrderId).update({ paymentStatus: 'refunded' });
    const attempts = await Promise.all([
      fetch(endpoint, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ status: 'rechazado' }) }),
      fetch(endpoint, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ status: 'rechazado' }) })
    ]);
    const bodies = await Promise.all(attempts.map(response => response.json()));
    assert.ok(attempts.every(response => response.status === 200), JSON.stringify(bodies));
    const orderAfterReject = (await firestore.collection('pedidos').doc(refundOrderId).get()).data();
    assert.equal(orderAfterReject.status, 'rechazado');

    const repeated = await fetch(endpoint, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ status: 'rechazado' })
    });
    assert.equal(repeated.status, 200);
  });

  await t.test('un pedido de prueba recorre todas las etapas sin tocar inventario ni pagos', async () => {
    const testOrderId = 'http-test-order-' + randomUUID();
    const testProductId = 'http-test-product-' + randomUUID();
    const orderRef = firestore.collection('pedidos').doc(testOrderId);
    const adminRef = firestore.collection('administradores').doc(adminEmail);
    await orderRef.set({
      esPrueba: true,
      status: 'nuevo',
      paymentMethod: 'prueba',
      paymentStatus: 'not_applicable',
      items: [{ qty: 2, name: 'Producto aislado para pedido ficticio', price: 100 }]
    });
    await adminRef.set({ enabled: true });

    try {
      const endpoint = baseUrl + '/api/admin/orders/' + testOrderId + '/status';
      const adminHeaders = { authorization: 'Bearer ' + adminIdToken, 'content-type': 'application/json' };
      for (const status of ['preparacion', 'listo', 'finalizado']) {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ status })
        });
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.success, true);
        const saved = (await orderRef.get()).data();
        assert.equal(saved.status, status);
        assert.equal(saved.testResolution, 'accepted');
        assert.equal(saved.paymentStatus, 'not_applicable');
      }

      const completed = (await orderRef.get()).data();
      assert.ok(completed.testResolvedAt);
      assert.ok(completed.testCompletedAt);

      const invalid = await fetch(endpoint, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ status: 'preparacion' })
      });
      assert.equal(invalid.status, 409, 'un pedido de prueba finalizado no se puede reabrir');
    } finally {
      await adminRef.delete();
      await orderRef.delete();
    }
  });

  await t.test('el administrador puede revalidar un pago aprobado sin inventario automático', async () => {
    const retryProductId = 'http-retry-' + randomUUID();
    const retryReference = randomUUID();
    const retryPaymentId = String(Math.floor(100000000 + Math.random() * 900000000));
    const retryIncidentId = retryReference;
    const adminRef = firestore.collection('administradores').doc(adminEmail);
    const pendingRef = firestore.collection('pagos_pendientes').doc(retryReference);
    const incidentRef = firestore.collection('incidencias_pagos').doc(retryIncidentId);
    const originalPayment = globalThis.__masayMockPayment;
    const preferenceCallsBefore = globalThis.__masayMockPreferenceCalls;

    await firestore.collection('productos').doc(retryProductId).set({
      name: 'Producto de reintento administrativo',
    });
    const pendingOrder = {
      items: [{ qty: 1, name: 'Producto de reintento administrativo', price: 100 }],
      total: 100,
      clientName: 'Pedido de prueba de emulador'
    };
    await pendingRef.set({
      uid: userUid,
      userEmail: customerEmail,
      total: 100,
      preferenceId: 'pref-retry-emulator',
      order: pendingOrder,
    });
    await incidentRef.set({
      type: 'approved_payment_stock_unavailable',
      status: 'needs_admin_review',
      paymentStatus: 'approved',
      paymentId: retryPaymentId,
      externalReference: retryReference,
      total: 100,
      currency: 'ARS',
      uid: userUid,
      userEmail: customerEmail,
      order: pendingOrder
    });
    await adminRef.set({ enabled: true });
    globalThis.__masayMockPayment = {
      id: retryPaymentId,
      status: 'approved',
      external_reference: retryReference,
      currency_id: 'ARS',
      transaction_amount: 100,
      preference_id: 'pref-retry-emulator',
      metadata: { user_uid: userUid }
    };

    try {
      const endpoint = baseUrl + '/api/admin/payment-incidents/incidencias_pagos/' + retryIncidentId + '/retry-approved-payment';
      const headers = { authorization: 'Bearer ' + adminIdToken };
      const attempts = await Promise.all([
        fetch(endpoint, { method: 'POST', headers }),
        fetch(endpoint, { method: 'POST', headers })
      ]);
      const bodies = await Promise.all(attempts.map(response => response.json()));
      assert.ok(attempts.every(response => response.status === 200), JSON.stringify(bodies));
      assert.ok(bodies.every(body => body.success), JSON.stringify(bodies));

      const product = (await firestore.collection('productos').doc(retryProductId).get()).data();
      const savedOrder = await firestore.collection('pedidos').doc(retryReference).get();
      assert.equal(savedOrder.exists, true);
      assert.equal(savedOrder.data().paymentStatus, 'approved');
      assert.equal((await pendingRef.get()).exists, false);
      assert.equal((await incidentRef.get()).data().status, 'resolved');
      assert.equal(globalThis.__masayMockPreferenceCalls, preferenceCallsBefore, 'reintentar no crea otra preferencia ni inicia otro cobro');
    } finally {
      globalThis.__masayMockPayment = originalPayment;
      await adminRef.delete();
      await pendingRef.delete();
      await incidentRef.delete();
      await firestore.collection('pedidos').doc(retryReference).delete();
      await firestore.collection('productos').doc(retryProductId).delete();
    }
  });

  await t.test('el reintento administrativo no depende de cantidades de inventario', async () => {
    const retryProductId = 'http-retry-empty-' + randomUUID();
    const retryReference = randomUUID();
    const retryPaymentId = String(Math.floor(100000000 + Math.random() * 900000000));
    const adminRef = firestore.collection('administradores').doc(adminEmail);
    const pendingRef = firestore.collection('pagos_pendientes').doc(retryReference);
    const incidentRef = firestore.collection('incidencias_pagos').doc(retryReference);
    const originalPayment = globalThis.__masayMockPayment;

    await firestore.collection('productos').doc(retryProductId).set({
      name: 'Producto agotado de prueba',
    });
    const pendingOrder = {
      items: [{ qty: 1, name: 'Producto agotado de prueba', price: 100 }],
      total: 100
    };
    await pendingRef.set({
      uid: userUid,
      userEmail: customerEmail,
      total: 100,
      preferenceId: 'pref-retry-empty-emulator',
      order: pendingOrder,
    });
    await incidentRef.set({
      type: 'approved_payment_stock_unavailable',
      status: 'needs_admin_review',
      paymentStatus: 'approved',
      paymentId: retryPaymentId,
      externalReference: retryReference,
      total: 100,
      currency: 'ARS',
      uid: userUid,
      userEmail: customerEmail,
      order: pendingOrder
    });
    await adminRef.set({ enabled: true });
    globalThis.__masayMockPayment = {
      id: retryPaymentId,
      status: 'approved',
      external_reference: retryReference,
      currency_id: 'ARS',
      transaction_amount: 100,
      preference_id: 'pref-retry-empty-emulator',
      metadata: { user_uid: userUid }
    };

    try {
      const response = await fetch(
        baseUrl + '/api/admin/payment-incidents/incidencias_pagos/' + retryReference + '/retry-approved-payment',
        { method: 'POST', headers: { authorization: 'Bearer ' + adminIdToken } }
      );
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.success, true);
      assert.equal((await pendingRef.get()).exists, false);
      assert.equal((await firestore.collection('pedidos').doc(retryReference).get()).exists, true);
      assert.equal((await incidentRef.get()).data().status, 'resolved');
    } finally {
      globalThis.__masayMockPayment = originalPayment;
      await adminRef.delete();
      await pendingRef.delete();
      await incidentRef.delete();
      await firestore.collection('pedidos').doc(retryReference).delete();
      await firestore.collection('productos').doc(retryProductId).delete();
    }
  });

  await t.test('el endpoint de reintento rechaza incidencias incompletas antes de consultar el pago', async () => {
    const incidentId = randomUUID();
    const adminRef = firestore.collection('administradores').doc(adminEmail);
    const incidentRef = firestore.collection('incidencias_pagos').doc(incidentId);
    const paymentFetchesBefore = globalThis.__masayMockPaymentFetches;
    await adminRef.set({ enabled: true });
    await incidentRef.set({
      type: 'approved_payment_validation_failed',
      status: 'needs_admin_review',
      paymentStatus: 'approved',
      paymentId: '123456789',
      externalReference: incidentId
    });
    try {
      const response = await fetch(
        baseUrl + '/api/admin/payment-incidents/incidencias_pagos/' + incidentId + '/retry-approved-payment',
        { method: 'POST', headers: { authorization: 'Bearer ' + adminIdToken } }
      );
      const body = await response.json();
      assert.equal(response.status, 409, JSON.stringify(body));
      assert.equal(body.success, false);
      assert.equal(globalThis.__masayMockPaymentFetches, paymentFetchesBefore,
        'una incidencia de validación incompleta no debe disparar el reintento administrativo');
      assert.equal((await incidentRef.get()).data().status, 'needs_admin_review');
    } finally {
      await adminRef.delete();
      await incidentRef.delete();
    }
  });

  t.after(async () => {
    await firestore.collection('productos').doc(productId).delete();
    await firestore.collection('productos').doc(raceProductId).delete();
    await firestore.collection('productos').doc(noStockProductId).delete();
    await firestore.collection('productos').doc(restoreProductId).delete();
    await firestore.collection('pedidos').doc(refundOrderId).delete();
    if (customerEmail) await firestore.collection('administradores').doc(adminEmail).delete();
    if (raceExternalReference) {
      await firestore.collection('pagos_pendientes').doc(raceExternalReference).delete();
    }
    if (raceOrderId) {
      await firestore.collection('pedidos').doc(raceOrderId).delete();
    }
    await new Promise(resolve => server.close(resolve));
  });
});
