'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pushTokenDocumentId,
  validatePushToken,
  registerAdminPushToken,
  removeAdminPushToken,
  buildAdminOrderPushMessage,
  sendAdminOrderPushNotifications
} = require('../lib/admin-push-notifications');

const tokenA = 'fcm-token-' + 'a'.repeat(100);
const tokenB = 'fcm-token-' + 'b'.repeat(100);

test('push token IDs are deterministic hashes and never expose the token', () => {
  const id = pushTokenDocumentId(tokenA);
  assert.equal(id, pushTokenDocumentId(tokenA));
  assert.notEqual(id, tokenA);
  assert.notEqual(id, pushTokenDocumentId(tokenB));
  assert.equal(id.length, 64);
});

test('push token validation rejects short, oversized and whitespace tokens', () => {
  assert.equal(validatePushToken(tokenA), true);
  assert.equal(validatePushToken('short'), false);
  assert.equal(validatePushToken('x'.repeat(4097)), false);
  assert.equal(validatePushToken('x'.repeat(80) + ' '), false);
});

test('registerAdminPushToken stores a token under a hashed ID and binds it to the admin email', async () => {
  let stored;
  let storedId;
  const firestore = {
    collection(name) {
      assert.equal(name, 'admin_push_tokens');
      return {
        doc(id) {
          storedId = id;
          return { set: async value => { stored = value; } };
        }
      };
    }
  };
  const id = await registerAdminPushToken({ firestore, email: 'ADMIN@MASAYFANTASIAS.COM', token: tokenA });
  assert.equal(id, pushTokenDocumentId(tokenA));
  assert.equal(storedId, id);
  assert.equal(stored.email, 'admin@masayfantasias.com');
  assert.equal(stored.token, tokenA);
  assert.equal(stored.platform, 'web');
});

test('an administrator can remove only their own registered token', async () => {
  let deleted = false;
  const firestore = {
    collection() {
      return {
        doc() {
          return {
            get: async () => ({ exists: true, data: () => ({ email: 'admin@masayfantasias.com' }) }),
            delete: async () => { deleted = true; }
          };
        }
      };
    }
  };
  assert.equal(await removeAdminPushToken({ firestore, email: 'other@masayfantasias.com', token: tokenA }), false);
  assert.equal(deleted, false);
  assert.equal(await removeAdminPushToken({ firestore, email: 'ADMIN@MASAYFANTASIAS.COM', token: tokenA }), true);
  assert.equal(deleted, true);
});

test('new-order message contains only the order reference and concise display data', () => {
  const message = buildAdminOrderPushMessage('order-123', { clientName: 'Cliente', total: 12500 });
  assert.deepEqual(message.data, {
    type: 'new_order',
    title: '¡Nuevo pedido en Masay!',
    body: 'Cliente · $12.500',
    orderId: 'order-123',
    url: '/'
  });
  assert.equal(message.webpush.fcmOptions.link, 'https://www.masayfantasias.com/');
});

test('delivery incident push is clearly identified and references the affected order', () => {
  const message = buildAdminOrderPushMessage('order-issue-9', {
    deliveryIssue: true,
    issueReason: 'Cliente ausente en domicilio'
  });
  assert.deepEqual(message.data, {
    type: 'delivery_issue',
    title: '⚠️ Problema con una entrega',
    body: 'Cliente ausente en domicilio',
    orderId: 'order-issue-9',
    url: '/'
  });
  assert.equal(message.webpush.headers.Urgency, 'high');
});

test('push sender sends to registered devices and removes expired FCM tokens', async () => {
  const deleted = [];
  const docs = [
    { id: 'a', data: () => ({ token: tokenA, email: 'admin@masayfantasias.com' }), ref: { delete: async () => deleted.push('a') } },
    { id: 'b', data: () => ({ token: tokenB, email: 'admin@masayfantasias.com' }), ref: { delete: async () => deleted.push('b') } }
  ];
  const firestore = {
    collection(name) {
      return name === 'admin_push_tokens'
        ? { get: async () => ({ docs }) }
        : { get: async () => ({ docs: [{ id: 'admin@masayfantasias.com', data: () => ({}) }] }) };
    }
  };
  let sent;
  const messaging = {
    sendEachForMulticast: async message => {
      sent = message;
      return {
        successCount: 1,
        failureCount: 1,
        responses: [
          { success: true },
          { success: false, error: { code: 'messaging/registration-token-not-registered' } }
        ]
      };
    }
  };
  const result = await sendAdminOrderPushNotifications({
    firestore, messaging, orderId: 'order-456',
    order: { clientName: 'Cliente', total: 5000 },
    logger: { warn() {} }
  });
  assert.deepEqual(result, { successCount: 1, failureCount: 1, tokenCount: 2 });
  assert.deepEqual(sent.tokens, [tokenA, tokenB]);
  assert.equal(sent.data.orderId, 'order-456');
  assert.deepEqual(deleted, ['b']);
});

test('push sender does not call FCM when no administrator devices are registered', async () => {
  let called = false;
  const result = await sendAdminOrderPushNotifications({
    firestore: {
      collection: () => ({ get: async () => ({ docs: [] }) })
    },
    messaging: { sendEachForMulticast: async () => { called = true; } },
    orderId: 'order-empty',
    order: {}
  });
  assert.equal(called, false);
  assert.deepEqual(result, { successCount: 0, failureCount: 0, tokenCount: 0 });
});

test('push sender excludes devices belonging to accounts no longer listed as administrators', async () => {
  const docs = [
    { id: 'active', data: () => ({ token: tokenA, email: 'admin@masayfantasias.com' }), ref: { delete: async () => {} } },
    { id: 'revoked', data: () => ({ token: tokenB, email: 'revoked@masayfantasias.com' }), ref: { delete: async () => {} } }
  ];
  const firestore = {
    collection(name) {
      if (name === 'admin_push_tokens') return { get: async () => ({ docs }) };
      return { get: async () => ({ docs: [{ id: 'admin@masayfantasias.com', data: () => ({}) }] }) };
    }
  };
  let sentTokens = [];
  const messaging = {
    sendEachForMulticast: async message => {
      sentTokens = message.tokens;
      return { successCount: 1, failureCount: 0, responses: [{ success: true }] };
    }
  };
  const result = await sendAdminOrderPushNotifications({
    firestore, messaging, orderId: 'order-active', order: { clientName: 'Cliente', total: 100 }
  });
  assert.deepEqual(sentTokens, [tokenA]);
  assert.equal(result.tokenCount, 1);
});


test('push test message does not expose or create an order', () => {
  const message = buildAdminOrderPushMessage('push-test', { pushTest: true });
  assert.deepEqual(message.data, {
    type: 'push_test',
    title: 'Prueba de notificaciones de Masay',
    body: 'Las alertas están funcionando correctamente en este dispositivo.',
    orderId: '',
    url: '/'
  });
  assert.equal(message.webpush.fcmOptions.link, 'https://www.masayfantasias.com/');
});


test('push test can be scoped to devices owned by the requesting administrator', async () => {
  const docs = [
    { id: 'a', data: () => ({ token: tokenA, email: 'admin@masayfantasias.com' }), ref: { delete: async () => {} } },
    { id: 'b', data: () => ({ token: tokenB, email: 'other@masayfantasias.com' }), ref: { delete: async () => {} } }
  ];
  const firestore = {
    collection(name) {
      return name === 'admin_push_tokens'
        ? { get: async () => ({ docs }) }
        : { get: async () => ({ docs: [
          { id: 'admin@masayfantasias.com', data: () => ({}) },
          { id: 'other@masayfantasias.com', data: () => ({}) }
        ] }) };
    }
  };
  let sentTokens = [];
  const messaging = {
    sendEachForMulticast: async message => {
      sentTokens = message.tokens;
      return { successCount: 1, failureCount: 0, responses: [{ success: true }] };
    }
  };
  const result = await sendAdminOrderPushNotifications({
    firestore, messaging, orderId: 'push-test', order: { pushTest: true },
    onlyEmail: 'ADMIN@MASAYFANTASIAS.COM'
  });
  assert.deepEqual(sentTokens, [tokenA]);
  assert.equal(result.tokenCount, 1);
});
