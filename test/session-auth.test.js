'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionAuthenticator } = require('../lib/session-auth');

function setup({ decoded = { uid: 'user-1', email: 'courier@example.com' }, verifyError = null, isAdmin = false } = {}) {
  const calls = [];
  const firebaseAuth = {
    async verifyIdToken(token, checkRevoked) {
      calls.push({ token, checkRevoked });
      if (verifyError) throw verifyError;
      return decoded;
    }
  };
  const firestore = {
    collection(name) {
      assert.equal(name, 'administradores');
      return {
        doc(email) {
          assert.equal(email, decoded.email);
          return { get: async () => ({ exists: isAdmin }) };
        }
      };
    }
  };
  return { ...createSessionAuthenticator({ firebaseAuth, firestore }), calls };
}

test('requires a Bearer token before verifying a session', async () => {
  const auth = setup();
  await assert.rejects(auth.authenticatedUser({ headers: {} }), { message: 'AUTH_REQUIRED' });
  assert.deepEqual(auth.calls, []);
});

test('verifies Firebase ID tokens with revocation checks enabled', async () => {
  const auth = setup();
  const user = await auth.authenticatedUser({ headers: { authorization: 'Bearer valid-token' } });
  assert.equal(user.email, 'courier@example.com');
  assert.deepEqual(auth.calls, [{ token: 'valid-token', checkRevoked: true }]);
});

test('normalizes expired, invalid, revoked, and disabled sessions to AUTH_REQUIRED', async () => {
  const auth = setup({ verifyError: new Error('Firebase token revoked') });
  await assert.rejects(
    auth.authenticatedUser({ headers: { authorization: 'Bearer revoked-token' } }),
    { message: 'AUTH_REQUIRED' }
  );
});

test('rejects verified sessions without an email claim', async () => {
  const auth = setup({ decoded: { uid: 'user-without-email' } });
  await assert.rejects(
    auth.authenticatedUser({ headers: { authorization: 'Bearer valid-token' } }),
    { message: 'AUTH_EMAIL_REQUIRED' }
  );
});

test('allows an administrator only when their administrator document exists', async () => {
  const auth = setup({ isAdmin: true });
  const user = await auth.authenticatedAdmin({ headers: { authorization: 'Bearer admin-token' } });
  assert.equal(user.email, 'courier@example.com');
});

test('denies a valid customer or courier session from administrator endpoints', async () => {
  const auth = setup({ isAdmin: false });
  await assert.rejects(
    auth.authenticatedAdmin({ headers: { authorization: 'Bearer courier-token' } }),
    { message: 'ADMIN_REQUIRED' }
  );
  assert.equal(auth.calls.length, 1);
});
