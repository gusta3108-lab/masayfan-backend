'use strict';

async function reserveDisplayOrderNumber(transaction, counterRef, FieldValue) {
  const snapshot = await transaction.get(counterRef);
  const lastNumber = snapshot.exists ? Number(snapshot.data().lastNumber || 0) : 0;
  if (!Number.isSafeInteger(lastNumber) || lastNumber < 0 || lastNumber >= Number.MAX_SAFE_INTEGER) {
    throw new Error('ORDER_NUMBER_SEQUENCE_INVALID');
  }
  const nextNumber = lastNumber + 1;
  transaction.set(counterRef, {
    lastNumber: nextNumber,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return String(nextNumber).padStart(4, '0');
}

module.exports = { reserveDisplayOrderNumber };
