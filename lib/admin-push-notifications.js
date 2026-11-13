'use strict';

const crypto = require('node:crypto');

const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered'
]);

function pushTokenDocumentId(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function validatePushToken(token) {
  return typeof token === 'string' && token.length >= 50 && token.length <= 4096
    && !/\s/.test(token);
}

async function registerAdminPushToken({ firestore, email, token }) {
  if (!firestore) throw new Error('Firestore no está configurado.');
  if (typeof email !== 'string' || !email.trim()) throw new Error('Correo de administrador inválido.');
  if (!validatePushToken(token)) throw new Error('Token de notificaciones inválido.');
  const id = pushTokenDocumentId(token);
  await firestore.collection('admin_push_tokens').doc(id).set({
    email: email.trim().toLowerCase(),
    token,
    platform: 'web',
    updatedAt: new Date().toISOString()
  }, { merge: true });
  return id;
}

async function removeAdminPushToken({ firestore, email, token }) {
  if (!firestore) throw new Error('Firestore no está configurado.');
  if (typeof email !== 'string' || !email.trim()) throw new Error('Correo de administrador inválido.');
  if (!validatePushToken(token)) throw new Error('Token de notificaciones inválido.');
  const ref = firestore.collection('admin_push_tokens').doc(pushTokenDocumentId(token));
  const snapshot = await ref.get();
  if (!snapshot.exists || String(snapshot.data().email || '').toLowerCase() !== email.trim().toLowerCase()) {
    return false;
  }
  await ref.delete();
  return true;
}

function buildAdminOrderPushMessage(orderId, order = {}) {
  if (order.pushTest === true) {
    return {
      data: {
        type: 'push_test',
        title: 'Prueba de notificaciones de Masay',
        body: 'Las alertas están funcionando correctamente en este dispositivo.',
        orderId: '',
        url: '/'
      },
      webpush: {
        headers: { Urgency: 'normal' },
        fcmOptions: { link: 'https://www.masayfantasias.com/' }
      }
    };
  }
  if (order.deliveryIssue === true) {
    return {
      data: {
        type: 'delivery_issue',
        title: '⚠️ Problema con una entrega',
        body: String(order.issueReason || 'Un repartidor reportó un inconveniente.').trim().slice(0, 120),
        orderId: String(orderId),
        url: '/'
      },
      webpush: {
        headers: { Urgency: 'high' },
        fcmOptions: { link: 'https://www.masayfantasias.com/' }
      }
    };
  }
  const customer = String(order.clientName || 'Cliente').trim().slice(0, 80);
  const total = Number(order.total || 0);
  const formattedTotal = Number.isFinite(total)
    ? '$' + total.toLocaleString('es-AR', { maximumFractionDigits: 2 })
    : 'Consultar total';
  return {
    data: {
      type: 'new_order',
      title: '¡Nuevo pedido en Masay!',
      body: customer + ' · ' + formattedTotal,
      orderId: String(orderId),
      url: '/'
    },
    webpush: {
      headers: { Urgency: 'high' },
      fcmOptions: { link: 'https://www.masayfantasias.com/' }
    }
  };
}

async function sendAdminOrderPushNotifications({ firestore, messaging, orderId, order, logger = console, onlyEmail = null }) {
  if (!firestore || !messaging) throw new Error('Firestore y Firebase Messaging son obligatorios.');
  const [snapshot, adminsSnapshot] = await Promise.all([
    firestore.collection('admin_push_tokens').get(),
    firestore.collection('administradores').get()
  ]);
  const adminEmails = new Set((adminsSnapshot.docs || []).map(doc =>
    String(doc.id || doc.data()?.email || '').trim().toLowerCase()
  ).filter(Boolean));
  // Never send order details to a device whose administrator account was revoked.
  const targetEmail = typeof onlyEmail === 'string' ? onlyEmail.trim().toLowerCase() : null;
  const docs = (snapshot.docs || []).filter(doc => {
    const data = doc.data() || {};
    const email = String(data.email || '').trim().toLowerCase();
    return validatePushToken(data.token)
      && adminEmails.has(email)
      && (!targetEmail || email === targetEmail);
  });
  if (docs.length === 0) return { successCount: 0, failureCount: 0, tokenCount: 0 };

  const message = buildAdminOrderPushMessage(orderId, order);
  let successCount = 0;
  let failureCount = 0;
  for (let offset = 0; offset < docs.length; offset += 500) {
    const batch = docs.slice(offset, offset + 500);
    const result = await messaging.sendEachForMulticast({
      ...message,
      tokens: batch.map(doc => doc.data().token)
    });
    successCount += Number(result.successCount || 0);
    failureCount += Number(result.failureCount || 0);
    const staleTokenDeletes = [];
    (result.responses || []).forEach((response, index) => {
      const code = response.error?.code;
      if (!response.success && INVALID_TOKEN_CODES.has(code)) {
        staleTokenDeletes.push(batch[index].ref.delete());
      }
    });
    if (staleTokenDeletes.length) await Promise.all(staleTokenDeletes);
  }
  if (failureCount > 0) logger.warn?.('Firebase Messaging informó envíos fallidos para notificaciones de pedidos.', { failureCount });
  return { successCount, failureCount, tokenCount: docs.length };
}

module.exports = {
  pushTokenDocumentId,
  validatePushToken,
  registerAdminPushToken,
  removeAdminPushToken,
  buildAdminOrderPushMessage,
  sendAdminOrderPushNotifications
};
