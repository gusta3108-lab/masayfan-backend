'use strict';

async function saveCourierProfileSafely({ firestore, courierRef, courier, active, adminEmail, FieldValue }) {
  let existed = false;
  await firestore.runTransaction(async transaction => {
    const currentSnap = await transaction.get(courierRef);
    existed = currentSnap.exists;
    const current = currentSnap.exists ? currentSnap.data() : {};

    if (active === false && currentSnap.exists) {
      const assignedQuery = firestore.collection('pedidos')
        .where('delivery.courierId', '==', courierRef.id);
      const assignedSnapshot = await transaction.get(assignedQuery);
      const hasActiveDeliveries = assignedSnapshot.docs.some(doc =>
        ['assigned', 'en_camino'].includes(String(doc.data().delivery?.status || ''))
      );
      if (hasActiveDeliveries) throw new Error('COURIER_HAS_ACTIVE_DELIVERIES');
    }

    transaction.set(courierRef, {
      ...courier,
      active: active !== false,
      createdAt: current.createdAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: String(adminEmail || '').trim().toLowerCase(),
      assignmentRevision: Number(current.assignmentRevision) || 0
    }, { merge: true });
  });
  return existed;
}

function markCourierAssignment(transaction, courierRef, FieldValue) {
  transaction.update(courierRef, {
    assignmentRevision: FieldValue.increment(1)
  });
}

module.exports = { saveCourierProfileSafely, markCourierAssignment };
