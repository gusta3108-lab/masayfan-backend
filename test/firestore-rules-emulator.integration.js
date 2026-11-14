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
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  return JSON.parse(responseText);
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

test('Firestore rules authorize the admin console without exposing admin data to customers', async t => {
  const admin = await createUser();
  const customer = await createUser();
  const productId = `admin-rules-product-${randomUUID()}`;
  const managedProductId = `admin-rules-managed-product-${randomUUID()}`;
  const costId = `admin-rules-cost-${randomUUID()}`;

  await seed(`administradores/${admin.email}`, {
    role: { stringValue: 'admin' }
  });
  await seed(`productos/${productId}`, {
    name: { stringValue: 'Producto administrable' },
    activo: { booleanValue: true }
  });
  await seed(`productos/${managedProductId}`, {
    name: { stringValue: 'Producto con inventario existente' },
    activo: { booleanValue: true },
    stockManaged: { booleanValue: true },
    stockQuantity: { integerValue: '8' },
    stockReserved: { integerValue: '2' }
  });
  await seed(`costos_productos/${costId}`, {
    costo: { integerValue: '250' }
  });
  await seed('config/local', {
    abierto: { booleanValue: true }
  });

  await t.test('el administrador puede consultar su propio documento de rol', async () => {
    const response = await request(`administradores/${admin.email}`, { token: admin.idToken });
    assert.equal(response.status, 200);
  });

  await t.test('un cliente no puede consultar el documento de administrador ajeno', async () => {
    const response = await request(`administradores/${admin.email}`, { token: customer.idToken });
    assert.equal(response.status, 403);
  });

  await t.test('el administrador puede leer el tablero completo de pedidos', async () => {
    const response = await request('pedidos', { token: admin.idToken });
    assert.equal(response.status, 200, await response.text());
  });

  await t.test('el administrador puede leer y actualizar costos privados', async () => {
    const read = await request(`costos_productos/${costId}`, { token: admin.idToken });
    assert.equal(read.status, 200);
    const update = await request(`costos_productos/${costId}`, {
      token: admin.idToken,
      method: 'PATCH',
      body: { fields: { costo: { integerValue: '300' } } }
    });
    assert.equal(update.status, 200, await update.text());
  });

  await t.test('el administrador puede modificar el catálogo', async () => {
    const response = await request(`productos/${productId}`, {
      token: admin.idToken,
      method: 'PATCH',
      body: { fields: {
        name: { stringValue: 'Producto actualizado' },
        activo: { booleanValue: true }
      } }
    });
    assert.equal(response.status, 200, await response.text());
  });

  await t.test('un cliente no puede modificar el catálogo ni sus costos', async () => {
    const productUpdate = await request(`productos/${productId}`, {
      token: customer.idToken,
      method: 'PATCH',
      body: { fields: { name: { stringValue: 'Modificación no autorizada' } } }
    });
    assert.equal(productUpdate.status, 403);
    const costUpdate = await request(`costos_productos/${costId}`, {
      token: customer.idToken,
      method: 'PATCH',
      body: { fields: { costo: { integerValue: '1' } } }
    });
    assert.equal(costUpdate.status, 403);
  });

  await t.test('el administrador no puede crear productos con inventario administrado mientras está bloqueado', async () => {
    const response = await request('productos', {
      token: admin.idToken,
      method: 'POST',
      body: { fields: {
        name: { stringValue: 'Producto con inventario no autorizado' },
        activo: { booleanValue: true },
        stockManaged: { booleanValue: true },
        stockQuantity: { integerValue: '5' },
        stockReserved: { integerValue: '0' }
      } }
    });
    assert.equal(response.status, 403);
  });

  await t.test('el administrador no puede activar inventario por stockManaged en un producto existente', async () => {
    const response = await request(`productos/${productId}`, {
      token: admin.idToken,
      method: 'PATCH',
      body: { fields: {
        stockManaged: { booleanValue: true },
        stockQuantity: { integerValue: '5' },
        stockReserved: { integerValue: '0' }
      } }
    });
    assert.equal(response.status, 403);
  });

  await t.test('el administrador no puede activar inventario agregando solo stockQuantity', async () => {
    const response = await request(`productos/${productId}`, {
      token: admin.idToken,
      method: 'PATCH',
      body: { fields: { stockQuantity: { integerValue: '5' } } }
    });
    assert.equal(response.status, 403);
  });

  await t.test('el inventario que ya estaba administrado puede seguir actualizándose', async () => {
    const response = await request(`productos/${managedProductId}`, {
      token: admin.idToken,
      method: 'PATCH',
      body: { fields: {
        stockManaged: { booleanValue: true },
        stockQuantity: { integerValue: '10' },
        stockReserved: { integerValue: '2' }
      } }
    });
    assert.equal(response.status, 200, await response.text());
  });

  await t.test('el administrador puede cambiar el estado del local y el cliente solo leerlo', async () => {
    const customerRead = await request('config/local', { token: customer.idToken });
    assert.equal(customerRead.status, 200);
    const customerWrite = await request('config/local', {
      token: customer.idToken,
      method: 'PATCH',
      body: { fields: { abierto: { booleanValue: false } } }
    });
    assert.equal(customerWrite.status, 403);
    const adminWrite = await request('config/local', {
      token: admin.idToken,
      method: 'PATCH',
      body: { fields: { abierto: { booleanValue: true } } }
    });
    assert.equal(adminWrite.status, 200, await adminWrite.text());
  });
});
