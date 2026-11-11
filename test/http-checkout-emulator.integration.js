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
globalThis.__masayMockPayment = null;

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
    if (!globalThis.__masayMockPayment) throw new Error('No se configuró el pago simulado.');
    return globalThis.__masayMockPayment;
  }
}
class InvalidWebhookSignatureError extends Error {}
class WebhookSignatureValidator {
  static validate() {
    // La firma se simula aquí: este test verifica el flujo HTTP y la lógica
    // posterior, no la criptografía del SDK real (cubierta por su integración).
    return true;
  }
}

const mpPath = require.resolve('mercadopago');
require.cache[mpPath] = {
  id: mpPath,
  filename: mpPath,
  loaded: true,
  exports: {
    MercadoPagoConfig,
    Preference,
    Payment,
    WebhookSignatureValidator,
    InvalidWebhookSignatureError
  }
};

const app = require('../server');
const { getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const firestore = getFirestore();
const { randomUUID } = crypto;

let server;
let baseUrl;
let idToken;
let userUid;
const productId = 'http-checkout-' + randomUUID();

test('HTTP efectivo y Mercado Pago simulado completan compras sin tocar producción', async t => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = 'http://127.0.0.1:' + server.address().port;

  const email = 'checkout-' + randomUUID() + '@example.test';
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

    const webhook = await fetch(
      baseUrl + '/api/webhook?type=payment&data.id=987654321',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature': 'ts=1,v1=emulator',
          'x-request-id': 'emulator-request-1'
        },
        body: JSON.stringify({ type: 'payment', data: { id: '987654321' } })
      }
    );
    assert.equal(webhook.status, 200);

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
      baseUrl + '/api/webhook?type=payment&data.id=987654321',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature': 'ts=1,v1=emulator',
          'x-request-id': 'emulator-request-2'
        },
        body: JSON.stringify({ type: 'payment', data: { id: '987654321' } })
      }
    );
    assert.equal(duplicate.status, 200);
    product = (await firestore.collection('productos').doc(productId).get()).data();
    assert.equal(product.stockQuantity, 3);
    assert.equal(product.stockReserved, 0);
  });

  t.after(async () => {
    await firestore.collection('productos').doc(productId).delete();
    await new Promise(resolve => server.close(resolve));
    await Promise.all(getApps().map(app => app.delete()));
  });
});
