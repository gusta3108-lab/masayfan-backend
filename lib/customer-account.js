'use strict';

async function requireCustomerAccount(user, firestore) {
  if (!user || !user.email) throw new Error('AUTH_EMAIL_REQUIRED');
  if (!firestore || typeof firestore.collection !== 'function') {
    throw new Error('FIRESTORE_UNAVAILABLE');
  }
  const adminSnap = await firestore.collection('administradores').doc(user.email).get();
  if (adminSnap.exists) throw new Error('ADMIN_CANNOT_PURCHASE');
  return user;
}

module.exports = { requireCustomerAccount };
