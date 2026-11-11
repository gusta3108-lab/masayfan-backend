'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { requireCustomerAccount } = require('../lib/customer-account');

function mockFirestore(isAdmin) {
  return {
    collection(name) {
      assert.equal(name, 'administradores');
      return {
        doc(email) {
          assert.equal(email, 'cliente@example.com');
          return { get: async () => ({ exists: isAdmin }) };
        }
      };
    }
  };
}

test('blocks a user whose email has an administrator document', async () => {
  await assert.rejects(
    requireCustomerAccount({ uid: 'admin-1', email: 'cliente@example.com' }, mockFirestore(true)),
    error => error.message === 'ADMIN_CANNOT_PURCHASE'
  );
});

test('allows a regular authenticated customer', async () => {
  const user = { uid: 'customer-1', email: 'cliente@example.com' };
  assert.equal(await requireCustomerAccount(user, mockFirestore(false)), user);
});

test('rejects missing email before querying Firestore', async () => {
  await assert.rejects(
    requireCustomerAccount({ uid: 'missing-email' }, mockFirestore(false)),
    error => error.message === 'AUTH_EMAIL_REQUIRED'
  );
});

test('fails closed when Firestore is unavailable', async () => {
  await assert.rejects(
    requireCustomerAccount({ uid: 'customer-1', email: 'cliente@example.com' }, null),
    error => error.message === 'FIRESTORE_UNAVAILABLE'
  );
});
