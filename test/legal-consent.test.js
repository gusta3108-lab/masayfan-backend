'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CURRENT_TERMS_VERSION,
  CURRENT_PRIVACY_VERSION,
  isCurrentCourierConsent,
  isCurrentConsentSubmission
} = require('../lib/legal-consent');

test('courier access requires the current terms and privacy versions', () => {
  assert.equal(CURRENT_TERMS_VERSION, '2.0');
  assert.equal(CURRENT_PRIVACY_VERSION, '2.0');
  assert.equal(isCurrentCourierConsent({ termsAccepted: true, termsVersion: '2.0', privacyVersion: '2.0' }), true);
  assert.equal(isCurrentCourierConsent({ termsAccepted: true, termsVersion: '1.0', privacyVersion: '1.0' }), false);
  assert.equal(isCurrentCourierConsent({ termsAccepted: false, termsVersion: '2.0', privacyVersion: '2.0' }), false);
  assert.equal(isCurrentCourierConsent({ termsAccepted: true, termsVersion: '2.0', privacyVersion: '1.0' }), false);
});

test('courier consent submissions must explicitly accept both current documents', () => {
  assert.equal(isCurrentConsentSubmission({ termsAccepted: true, termsVersion: '2.0', privacyVersion: '2.0' }), true);
  assert.equal(isCurrentConsentSubmission({ termsAccepted: false, termsVersion: '2.0', privacyVersion: '2.0' }), false);
  assert.equal(isCurrentConsentSubmission({ termsAccepted: true, termsVersion: '1.0', privacyVersion: '1.0' }), false);
  assert.equal(isCurrentConsentSubmission({ termsAccepted: true, termsVersion: '2.0', privacyVersion: '1.0' }), false);
});
