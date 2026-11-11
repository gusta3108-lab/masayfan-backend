'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { randomUUID } = require('node:crypto');
const { createInventoryService } = require('../lib/inventory');

const projectId = 'demo-masayfantasias';
admin.initializeApp({ projectId });
const firestore = admin.firestore();
const inventory = createInventoryService({ getFirestore: () => firestore, admin });

const item = (productId, qty = 1) => [{ stockProductId: productId, qty }];
const unique = prefix => prefix + '-' + randomUUID();

test('two concurrent buyers cannot reserve the final unit', async () => {
  const productId = unique('race-product');
  const productRef = firestore.collection('productos').doc(productId);
  await productRef.set({ name: 'Producto de prueba', stockManaged: true, stockQuantity: 1, stockReserved: 0 });

  const attempts = await Promise.allSettled([
    firestore.runTransaction(tx => inventory.reserveInventory(tx, item(productId))),
    firestore.runTransaction(tx => inventory.reserveInventory(tx, item(productId)))
  ]);

  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
  const product = (await productRef.get()).data();
  assert.equal(product.stockQuantity, 1);
  assert.equal(product.stockReserved, 1);
});

test('concurrent cleanup attempts release one reservation exactly once', async () => {
  const productId = unique('release-product');
  const pendingId = unique('pending');
  const productRef = firestore.collection('productos').doc(productId);
  const pendingRef = firestore.collection('pagos_pendientes').doc(pendingId);
  await productRef.set({ name: 'Producto de prueba', stockManaged: true, stockQuantity: 5, stockReserved: 1 });
  await pendingRef.set({
    order: { items: item(productId) },
    expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() - 60000))
  });

  const released = await Promise.all([
    inventory.releasePendingInventory(pendingRef),
    inventory.releasePendingInventory(pendingRef)
  ]);

  assert.equal(released.filter(Boolean).length, 1);
  assert.equal((await productRef.get()).data().stockReserved, 0);
  const pending = (await pendingRef.get()).data();
  assert.equal(pending.inventoryReleased, true);
  assert.equal(Object.prototype.hasOwnProperty.call(pending, 'expiresAt'), false);
});

test('late approval after expiry consumes remaining stock without reusing the old reservation', async () => {
  const productId = unique('late-payment-product');
  const pendingId = unique('late-payment');
  const productRef = firestore.collection('productos').doc(productId);
  const pendingRef = firestore.collection('pagos_pendientes').doc(pendingId);
  await productRef.set({ name: 'Producto de prueba', stockManaged: true, stockQuantity: 2, stockReserved: 1 });
  await pendingRef.set({
    order: { items: item(productId) },
    expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() - 60000))
  });

  await inventory.releasePendingInventory(pendingRef);
  await firestore.runTransaction(tx => inventory.completeInventorySale(tx, item(productId), false));

  const product = (await productRef.get()).data();
  assert.equal(product.stockQuantity, 1);
  assert.equal(product.stockReserved, 0);
});

test('late approval is blocked if another sale consumed the units after expiry', async () => {
  const productId = unique('late-shortage-product');
  const pendingId = unique('late-shortage');
  const productRef = firestore.collection('productos').doc(productId);
  const pendingRef = firestore.collection('pagos_pendientes').doc(pendingId);
  await productRef.set({ name: 'Producto de prueba', stockManaged: true, stockQuantity: 1, stockReserved: 1 });
  await pendingRef.set({
    order: { items: item(productId) },
    expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() - 60000))
  });

  await inventory.releasePendingInventory(pendingRef);
  await firestore.runTransaction(tx => inventory.completeInventorySale(tx, item(productId), false));
  await assert.rejects(
    firestore.runTransaction(tx => inventory.completeInventorySale(tx, item(productId), false)),
    /STOCK_INSUFFICIENT/
  );
  const product = (await productRef.get()).data();
  assert.equal(product.stockQuantity, 0);
  assert.equal(product.stockReserved, 0);
});

test('cleanup cannot release inventory after an approved sale removed the pending payment', async () => {
  const productId = unique('approved-product');
  const pendingId = unique('approved-pending');
  const productRef = firestore.collection('productos').doc(productId);
  const pendingRef = firestore.collection('pagos_pendientes').doc(pendingId);
  await productRef.set({ name: 'Producto de prueba', stockManaged: true, stockQuantity: 3, stockReserved: 1 });
  await pendingRef.set({
    order: { items: item(productId) },
    expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() - 60000))
  });

  await firestore.runTransaction(async tx => {
    await inventory.completeInventorySale(tx, item(productId), true);
    tx.delete(pendingRef);
  });

  assert.equal(await inventory.releasePendingInventory(pendingRef), false);
  const product = (await productRef.get()).data();
  assert.equal(product.stockQuantity, 2);
  assert.equal(product.stockReserved, 0);
});

test('legacy products without inventory fields remain outside stock control', async () => {
  const productId = unique('legacy-product');
  const productRef = firestore.collection('productos').doc(productId);
  await productRef.set({ name: 'Producto antiguo', price: 100 });

  await firestore.runTransaction(tx => inventory.reserveInventory(tx, item(productId, 2)));
  await firestore.runTransaction(tx => inventory.completeInventorySale(tx, item(productId, 2), false));

  const product = (await productRef.get()).data();
  assert.equal(Object.prototype.hasOwnProperty.call(product, 'stockQuantity'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(product, 'stockReserved'), false);
});

test('corrupt stock counters fail safely instead of allowing a reservation', async () => {
  const productId = unique('corrupt-product');
  const productRef = firestore.collection('productos').doc(productId);
  await productRef.set({ name: 'Producto con datos inválidos', stockManaged: true, stockQuantity: 4, stockReserved: 5 });

  await assert.rejects(
    firestore.runTransaction(tx => inventory.reserveInventory(tx, item(productId))),
    /cantidades inválidas/
  );
  const product = (await productRef.get()).data();
  assert.equal(product.stockQuantity, 4);
  assert.equal(product.stockReserved, 5);
});

test.after(async () => {
  await admin.app().delete();
});
