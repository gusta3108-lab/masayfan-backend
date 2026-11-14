'use strict';

function createSessionAuthenticator({ firebaseAuth, firestore }) {
  async function authenticatedUser(req) {
    if (req?.masayAuthenticatedUser) return req.masayAuthenticatedUser;
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
    if (req && typeof req === 'object') req.masayAuthenticatedUser = decoded;
    return decoded;
  }

  async function authenticatedVerifiedUser(req) {
    const user = await authenticatedUser(req);
    if (user.email_verified !== true) throw new Error('EMAIL_NOT_VERIFIED');
    return user;
  }

  async function authenticatedAdmin(req) {
    const user = await authenticatedVerifiedUser(req);
    const email = String(user.email).trim().toLowerCase();
    const adminSnap = await firestore.collection('administradores').doc(email).get();
    if (!adminSnap.exists) throw new Error('ADMIN_REQUIRED');
    return user;
  }

  return { authenticatedUser, authenticatedVerifiedUser, authenticatedAdmin };
}

module.exports = { createSessionAuthenticator };
