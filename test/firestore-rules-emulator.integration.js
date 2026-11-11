'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const projectId = 'masayfantasias';
const firestoreBase = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;
const authBase = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-api-key';

async function createUser() {
  const email = `rules-${randomUUID()}@example.test`;
  const response = await fetch(authBase, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'EmulatorPass123!', returnSecureToken: true })
  });
  assert.equal(response.status, 200, await response.text());
  return response.json();
}

async function seed(path, fields) {
  const response = await fetch(`${firestoreBase}/${path}`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  assert.equal(response.status, 200, await response.text());
}

async function request(path, { token, method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  return fetch(`${firestoreBase}/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
}

test('Firestore security rules enforce public, owner, and server-only access', async t => {
  const owner = await createUser();
  const other = await createUser();
  const productId = `rules-product-${randomUUID()}`;
  const costId = `rules-cost-${randomUUID()}`;
  const orderId = `rules-order-${randomUUID()}`;

  await seed(`productos/${productId}`, {
    name: { stringValue: 'Producto de prueba' },
    activo: { booleanValue: true }
  });
  await seed(`costos_productos/${costId}`, {
    costo: { integerValue: '100' }
  });
  await seed(`pedidos/${orderId}`, {
    userEmail: { stringValue: owner.email },
    estado: { stringValue: 'pendiente' }
  });

  await t.test('el catálogo es legible sin iniciar sesión', async () => {
    const response = await request(`productos/${productId}`);
    assert.equal(response.status, 200);
  });

  await t.test('los costos privados no son legibles por clientes', async () => {
    const response = await request(`costos_productos/${costId}`, { token: owner.idToken });
    assert.equal(response.status, 403);
  });

  await t.test('el titular puede leer su pedido', async () => {
    const response = await request(`pedidos/${orderId}`, { token: owner.idToken });
    assert.equal(response.status, 200);
  });

  await t.test('otro cliente no puede leer el pedido ajeno', async () => {
    const response = await request(`pedidos/${orderId}`, { token: other.idToken });
    assert.equal(response.status, 403);
  });

  await t.test('el navegador no puede crear pedidos directamente', async () => {
    const response = await request('pedidos', {
      token: owner.idToken,
      method: 'POST',
      body: { fields: { userEmail: { stringValue: owner.email } } }
    });
    assert.equal(response.status, 403);
  });

  await t.test('el usuario puede crear solo su perfil mínimo', async () => {
    const response = await request(`clientes/${owner.localId}`, {
      token: owner.idToken,
      method: 'PATCH',
      body: { fields: {
        correo: { stringValue: owner.email },
        createdAt: { stringValue: new Date().toISOString() }
      } }
    });
    assert.equal(response.status, 200, await response.text());
  });

  await t.test('el perfil no admite campos para elevar permisos', async () => {
    const response = await request(`clientes/${other.localId}`, {
      token: other.idToken,
      method: 'PATCH',
      body: { fields: {
        correo: { stringValue: other.email },
        createdAt: { stringValue: new Date().toISOString() },
        admin: { booleanValue: true }
      } }
    });
    assert.equal(response.status, 403);
  });

  await t.test('las colecciones no declaradas quedan bloqueadas', async () => {
    const response = await request(`coleccion_desconocida/${randomUUID()}`, { token: owner.idToken });
    assert.equal(response.status, 403);
  });
});
