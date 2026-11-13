'use strict';

function createSessionAuthenticator({ firebaseAuth, firestore }) {
  async function authenticatedUser(req) {
    const header = req?.headers?.authorization || '';
    if (!header.startsWith('Bearer ')) throw new Error('AUTH_REQUIRED');

    let decoded;
    try {
      // checkRevoked=true rejects expired, revoked, and disabled-account sessions.
      decoded = await firebaseAuth.verifyIdToken(header.slice(7), true);
    } catch (_error) {
      throw new Error('AUTH_REQUIRED');
    }
    if (!decoded.email) throw new Error('AUTH_EMAIL_REQUIRED');
    return decoded;
  }

  async function authenticatedAdmin(req) {
    const user = await authenticatedUser(req);
    const adminSnap = await firestore.collection('administradores').doc(user.email).get();
    if (!adminSnap.exists) throw new Error('ADMIN_REQUIRED');
    return user;
  }

  return { authenticatedUser, authenticatedAdmin };
}

module.exports = { createSessionAuthenticator };
