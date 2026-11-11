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
process.env.INVENTORY_CLEANUP_SECRET = 'local-emulator-cleanup-secret';

globalThis.__masayMockPreference = null;
globalThis.__masayMockPayment = null;
globalThis.__masayMockPaymentFetches = 0;

class MercadoPagoConfig {
  constructor() {}
}
class Preference {
  async create({ body }) {
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
const productId = 'http-checkout-' + randomUUID();
const raceProductId = 'http-race-' + randomUUID();
const cleanupProductId = 'http-cleanup-' + randomUUID();
const expiredPendingId = 'http-expired-' + randomUUID();
const futurePendingId = 'http-future-' + randomUUID();
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

  await firestore.collection('productos').doc(productId).set({
    name: 'Producto HTTP de prueba',
    price: 100,
    activo: true,
    stockManaged: true,
    stockQuantity: 5,
    stockReserved: 0
  });

  const headers = {
    authorization: 'Bearer ' + idToken,
    'content-type': 'application/json'
  };
  const order = {
    clientName: 'Cliente de prueba',
    clientPhone: '1111111111',
    address: 'Dirección de prueba',
    notes: 'Solo emulador'
  };
  const items = [{ id: productId, qty: 1, price: 100, options: '' }];

  await t.test('el checkout en efectivo crea el pedido y descuenta stock', async () => {
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
    const product = (await firestore.collection('productos').doc(productId).get()).data();
    assert.equal(product.stockQuantity, 4);
    assert.equal(product.stockReserved, 0);
  });

  await t.test('Mercado Pago reserva stock y el webhook simulado confirma una sola venta', async () => {
    const response = await fetch(baseUrl + '/api/crear-preferencia', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ items, order })
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    assert.equal(body.init_point, 'https://sandbox.invalid/checkout/emulator');
    assert.equal(globalThis.__masayMockPreference.external_reference, body.external_reference);

    let product = (await firestore.collection('productos').doc(productId).get()).data();
    assert.equal(product.stockQuantity, 4);
    assert.equal(product.stockReserved, 1);

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
    assert.equal(mismatchedAmount.status, 500);
    assert.equal(globalThis.__masayMockPaymentFetches, 1);
    assert.equal(
      (await firestore.collection('pagos_pendientes').doc(body.external_reference).get()).exists,
      true,
      'un importe incorrecto no debe cerrar la orden pendiente'
    );
    product = (await firestore.collection('productos').doc(productId).get()).data();
    assert.equal(product.stockQuantity, 4);
    assert.equal(product.stockReserved, 1);

    globalThis.__masayMockPayment.transaction_amount = 100;
    const webhook = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signedWebhookHeaders('987654321', 'emulator-request-1', process.env.MP_WEBHOOK_SECRET)
      },
      body: webhookBody
    });
    assert.equal(webhook.status, 200);
    assert.equal(globalThis.__masayMockPaymentFetches, 2);

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
    assert.equal(product.stockQuantity, 3);
    assert.equal(product.stockReserved, 0);

    // Repetir el webhook no debe crear otro pedido ni volver a descontar stock.
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
    assert.equal(globalThis.__masayMockPaymentFetches, 3, 'cada webhook consulta el pago una sola vez');
    product = (await firestore.collection('productos').doc(productId).get()).data();
    assert.equal(product.stockQuantity, 3);
    assert.equal(product.stockReserved, 0);
  });

  await t.test('dos checkouts HTTP simultáneos (efectivo y Mercado Pago) no venden dos veces la última unidad', async () => {
    await firestore.collection('productos').doc(raceProductId).set({
      name: 'Producto de concurrencia HTTP',
      price: 100,
      activo: true,
      stockManaged: true,
      stockQuantity: 1,
      stockReserved: 0
    });
    const raceItems = [{ id: raceProductId, qty: 1, price: 100, options: '' }];
    const [cashResponse, mpResponse] = await Promise.all([
      fetch(baseUrl + '/api/pedidos/efectivo', {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ items: raceItems, order })
      }),
      fetch(baseUrl + '/api/crear-preferencia', {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ items: raceItems, order })
      })
    ]);
    const [cashBody, mpBody] = await Promise.all([cashResponse.json(), mpResponse.json()]);
    const outcomes = [
      { status: cashResponse.status, body: cashBody, method: 'efectivo' },
      { status: mpResponse.status, body: mpBody, method: 'mercadopago' }
    ];
    const winners = outcomes.filter(result => result.status === 201 || result.status === 200);
    const rejected = outcomes.filter(result => result.status === 409);

    assert.equal(winners.length, 1, JSON.stringify(outcomes));
    assert.equal(rejected.length, 1, JSON.stringify(outcomes));
    assert.equal(rejected[0].body.code, 'STOCK_INSUFFICIENT');
    if (winners[0].method === 'efectivo') {
      raceOrderId = winners[0].body.order_id;
      const product = (await firestore.collection('productos').doc(raceProductId).get()).data();
      assert.equal(product.stockQuantity, 0);
      assert.equal(product.stockReserved, 0);
    } else {
      raceExternalReference = winners[0].body.external_reference;
      assert.ok(raceExternalReference);
      const product = (await firestore.collection('productos').doc(raceProductId).get()).data();
      assert.equal(product.stockQuantity, 1);
      assert.equal(product.stockReserved, 1);
      assert.equal(
        (await firestore.collection('pagos_pendientes').doc(raceExternalReference).get()).exists,
        true
      );
    }
  });

  await t.test('el endpoint protegido libera solo reservas vencidas y la repetición no vuelve a descontar', async () => {
    const productRef = firestore.collection('productos').doc(cleanupProductId);
    const expiredRef = firestore.collection('pagos_pendientes').doc(expiredPendingId);
    const futureRef = firestore.collection('pagos_pendientes').doc(futurePendingId);
    const expiredAt = Timestamp.fromDate(new Date(Date.now() - 60000));
    const futureAt = Timestamp.fromDate(new Date(Date.now() + 60000));
    await productRef.set({
      name: 'Producto de limpieza HTTP',
      stockManaged: true,
      stockQuantity: 4,
      stockReserved: 2
    });
    await expiredRef.set({
      order: { items: [{ stockProductId: cleanupProductId, qty: 1 }] },
      inventoryReleased: false,
      expiresAt: expiredAt
    });
    await futureRef.set({
      order: { items: [{ stockProductId: cleanupProductId, qty: 1 }] },
      inventoryReleased: false,
      expiresAt: futureAt
    });

    const endpoint = baseUrl + '/api/internal/release-expired-inventory';
    const unauthorized = await fetch(endpoint, { method: 'POST' });
    assert.equal(unauthorized.status, 401);
    assert.equal((await productRef.get()).data().stockReserved, 2);

    const headersWithCleanupSecret = { 'x-inventory-cleanup-secret': process.env.INVENTORY_CLEANUP_SECRET };
    const firstRun = await fetch(endpoint, { method: 'POST', headers: headersWithCleanupSecret });
    const firstBody = await firstRun.json();
    assert.equal(firstRun.status, 200, JSON.stringify(firstBody));
    assert.equal(firstBody.success, true);
    assert.equal(firstBody.released, 1);
    assert.equal(firstBody.failed, 0);
    assert.equal(firstBody.checked, 1);

    let product = (await productRef.get()).data();
    assert.equal(product.stockQuantity, 4);
    assert.equal(product.stockReserved, 1);
    const expired = (await expiredRef.get()).data();
    assert.equal(expired.inventoryReleased, true);
    assert.equal(expired.expiresAt, undefined);
    assert.equal(expired.reservationExpiresAt.toMillis(), expiredAt.toMillis());
    const future = (await futureRef.get()).data();
    assert.equal(future.inventoryReleased, false);
    assert.equal(future.expiresAt.toMillis(), futureAt.toMillis());

    const secondRun = await fetch(endpoint, { method: 'POST', headers: headersWithCleanupSecret });
    const secondBody = await secondRun.json();
    assert.equal(secondRun.status, 200, JSON.stringify(secondBody));
    assert.equal(secondBody.success, true);
    assert.equal(secondBody.released, 0);
    assert.equal(secondBody.failed, 0);
    assert.equal(secondBody.checked, 0);
    product = (await productRef.get()).data();
    assert.equal(product.stockReserved, 1);
  });

  await t.test('el rechazo de un pago Mercado Pago exige devolución y restaura stock una sola vez', async () => {
    await firestore.collection('productos').doc(restoreProductId).set({
      name: 'Producto para prueba de devolución',
      stockManaged: true,
      stockQuantity: 1,
      stockReserved: 0
    });
    await firestore.collection('pedidos').doc(refundOrderId).set({
      items: [{ stockProductId: restoreProductId, qty: 1 }],
      status: 'nuevo',
      paymentMethod: 'mercadopago',
      paymentStatus: 'approved',
      inventoryCommitted: true,
      inventoryRestored: false
    });
    await firestore.collection('administradores').doc(customerEmail).set({ enabled: true });

    const endpoint = baseUrl + '/api/admin/orders/' + refundOrderId + '/status';
    const adminHeaders = { ...headers, 'content-type': 'application/json' };
    const beforeRefund = await fetch(endpoint, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ status: 'rechazado' })
    });
    const beforeRefundBody = await beforeRefund.json();
    assert.equal(beforeRefund.status, 409, JSON.stringify(beforeRefundBody));
    assert.equal(
      (await firestore.collection('productos').doc(restoreProductId).get()).data().stockQuantity,
      1,
      'no se devuelve inventario antes de confirmar el reembolso'
    );

    await firestore.collection('pedidos').doc(refundOrderId).update({ paymentStatus: 'refunded' });
    const attempts = await Promise.all([
      fetch(endpoint, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ status: 'rechazado' }) }),
      fetch(endpoint, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ status: 'rechazado' }) })
    ]);
    const bodies = await Promise.all(attempts.map(response => response.json()));
    assert.ok(attempts.every(response => response.status === 200), JSON.stringify(bodies));

    const product = (await firestore.collection('productos').doc(restoreProductId).get()).data();
    const orderAfterReject = (await firestore.collection('pedidos').doc(refundOrderId).get()).data();
    assert.equal(product.stockQuantity, 2);
    assert.equal(product.stockReserved, 0);
    assert.equal(orderAfterReject.status, 'rechazado');
    assert.equal(orderAfterReject.inventoryRestored, true);

    const repeated = await fetch(endpoint, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ status: 'rechazado' })
    });
    assert.equal(repeated.status, 200);
    assert.equal((await firestore.collection('productos').doc(restoreProductId).get()).data().stockQuantity, 2);
  });

  t.after(async () => {
    await firestore.collection('productos').doc(productId).delete();
    await firestore.collection('productos').doc(raceProductId).delete();
    await firestore.collection('productos').doc(cleanupProductId).delete();
    await firestore.collection('productos').doc(restoreProductId).delete();
    await firestore.collection('pedidos').doc(refundOrderId).delete();
    if (customerEmail) await firestore.collection('administradores').doc(customerEmail).delete();
    await firestore.collection('pagos_pendientes').doc(expiredPendingId).delete();
    await firestore.collection('pagos_pendientes').doc(futurePendingId).delete();
    if (raceExternalReference) {
      await firestore.collection('pagos_pendientes').doc(raceExternalReference).delete();
    }
    if (raceOrderId) {
      await firestore.collection('pedidos').doc(raceOrderId).delete();
    }
    await new Promise(resolve => server.close(resolve));
  });
});
