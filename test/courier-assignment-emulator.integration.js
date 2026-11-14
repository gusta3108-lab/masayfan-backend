'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { saveCourierProfileSafely, markCourierAssignment } = require('../lib/courier-assignment-guard');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('Estas pruebas requieren Firestore Emulator; se bloquea cualquier conexión a producción.');
}

const app = initializeApp({ projectId: 'demo-masayfantasias' }, 'courier-assignment-emulator-tests');
const firestore = getFirestore(app);
const unique = prefix => prefix + '-' + randomUUID();
const courierEmail = 'courier@example.test';
const courierId = require('../lib/delivery').courierDocumentId(courierEmail);

test('courier cannot be deactivated while assigned or in-transit deliveries exist', async () => {
  const courierRef = firestore.collection('repartidores').doc(courierId);
  const orderRef = firestore.collection('pedidos').doc(unique('active-delivery'));
  await courierRef.set({ email: courierEmail, name: 'Repartidor de prueba', active: true });
  await orderRef.set({ delivery: { courierId, status: 'assigned' } });

  await assert.rejects(
    saveCourierProfileSafely({
      firestore, courierRef, courier: { email: courierEmail, name: 'Repartidor de prueba' },
      active: false, adminEmail: 'admin@example.test', FieldValue
    }),
    /COURIER_HAS_ACTIVE_DELIVERIES/
  );
  assert.equal((await courierRef.get()).data().active, true);
  await orderRef.delete();
  await courierRef.delete();
});

test('assignment and deactivation serialize on the courier document under concurrency', async () => {
  const courierRef = firestore.collection('repartidores').doc(courierId);
  const orderRef = firestore.collection('pedidos').doc(unique('race-delivery'));
  await courierRef.set({ email: courierEmail, name: 'Repartidor de prueba', active: true });

  const assignment = firestore.runTransaction(async transaction => {
    const courierSnap = await transaction.get(courierRef);
    if (!courierSnap.exists || courierSnap.data().active === false) throw new Error('COURIER_NOT_AVAILABLE');
    const assignedQuery = firestore.collection('pedidos').where('delivery.courierId', '==', courierId);
    await transaction.get(assignedQuery);
    transaction.create(orderRef, { delivery: { courierId, status: 'assigned' } });
    markCourierAssignment(transaction, courierRef, FieldValue);
    return true;
  });

  const deactivation = saveCourierProfileSafely({
    firestore, courierRef, courier: { email: courierEmail, name: 'Repartidor de prueba' },
    active: false, adminEmail: 'admin@example.test', FieldValue
  });

  const results = await Promise.allSettled([assignment, deactivation]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1,
    'only assignment or deactivation may win; both must never commit');
  const courier = (await courierRef.get()).data();
  const activeOrders = await firestore.collection('pedidos')
    .where('delivery.courierId', '==', courierId).get();
  if (activeOrders.docs.length) {
    assert.equal(courier.active, true, 'a courier with an active delivery must remain enabled');
  } else {
    assert.equal(courier.active, false, 'a successfully deactivated courier must not receive a new assignment');
  }

  await Promise.all(activeOrders.docs.map(doc => doc.ref.delete()));
  await courierRef.delete();
});

test('courier with no active deliveries can be deactivated transactionally', async () => {
  const courierRef = firestore.collection('repartidores').doc(courierId);
  await courierRef.set({ email: courierEmail, name: 'Repartidor de prueba', active: true });
  const existed = await saveCourierProfileSafely({
    firestore, courierRef, courier: { email: courierEmail, name: 'Repartidor de prueba' },
    active: false, adminEmail: 'admin@example.test', FieldValue
  });
  assert.equal(existed, true);
  assert.equal((await courierRef.get()).data().active, false);
  await courierRef.delete();
});

test.after(async () => {
  await Promise.all(getApps().filter(app => app.name === 'courier-assignment-emulator-tests').map(app => app.delete()));
});
