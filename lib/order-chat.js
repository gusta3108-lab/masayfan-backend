'use strict';

function safeParticipantName(value, fallback) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  return name || fallback;
}

async function resolveOrderChatParticipant({ user, order, firestore, courierDocumentId }) {
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) throw new Error('AUTH_EMAIL_REQUIRED');

  const adminSnap = await firestore.collection('administradores').doc(email).get();
  if (adminSnap.exists) {
    return { role: 'admin', name: 'Administración', canSend: false };
  }

  if (String(order?.userEmail || '').trim().toLowerCase() === email) {
    return {
      role: 'customer',
      name: safeParticipantName(order.clientName, 'Cliente'),
      canSend: true
    };
  }

  let courierId;
  try {
    courierId = courierDocumentId(email);
  } catch (_error) {
    throw new Error('CHAT_FORBIDDEN');
  }
  const courierSnap = await firestore.collection('repartidores').doc(courierId).get();
  const courier = courierSnap.exists ? courierSnap.data() : null;
  if (courier && courier.active !== false
    && String(order?.delivery?.courierId || '') === courierId
    && String(courier.email || '').trim().toLowerCase() === email) {
    return {
      role: 'courier',
      name: safeParticipantName(order.delivery?.courierName || courier.name, 'Repartidor'),
      canSend: true
    };
  }

  throw new Error('CHAT_FORBIDDEN');
}

function isOrderChatClosed(order) {
  const deliveryStatus = String(order?.delivery?.status || '').toLowerCase();
  const orderStatus = String(order?.status || '').toLowerCase();
  return !String(order?.delivery?.courierId || '')
    || !['assigned', 'en_camino', 'issue'].includes(deliveryStatus)
    || ['rechazado', 'cancelado', 'finalizado'].includes(orderStatus)
    || ['cancelled', 'delivered'].includes(deliveryStatus);
}

function normalizeOrderChatMessage(value) {
  if (typeof value !== 'string') throw new Error('CHAT_MESSAGE_INVALID');
  const message = value.trim();
  if (!message || message.length > 1000) throw new Error('CHAT_MESSAGE_INVALID');
  return message;
}

module.exports = {
  resolveOrderChatParticipant,
  isOrderChatClosed,
  normalizeOrderChatMessage
};
