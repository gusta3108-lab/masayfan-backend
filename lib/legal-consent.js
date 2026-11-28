'use strict';

const CURRENT_TERMS_VERSION = '2.0';
const CURRENT_PRIVACY_VERSION = '2.0';

function isCurrentCourierConsent(courier = {}) {
  return courier?.termsAccepted === true
    && String(courier?.termsVersion || '') === CURRENT_TERMS_VERSION
    && String(courier?.privacyVersion || '') === CURRENT_PRIVACY_VERSION;
}

function isCurrentConsentSubmission(body = {}) {
  return body?.termsAccepted === true
    && body?.termsVersion === CURRENT_TERMS_VERSION
    && body?.privacyVersion === CURRENT_PRIVACY_VERSION;
}

module.exports = {
  CURRENT_TERMS_VERSION,
  CURRENT_PRIVACY_VERSION,
  isCurrentCourierConsent,
  isCurrentConsentSubmission
};
