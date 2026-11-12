'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedOrigin } = require('../lib/cors-origin');

test('allows only the production storefront origins', () => {
  assert.equal(isAllowedOrigin('https://masayfantasias.com'), true);
  assert.equal(isAllowedOrigin('https://www.masayfantasias.com'), true);
});

test('allows the current trusted Vercel preview and branch preview variants', () => {
  assert.equal(isAllowedOrigin('https://local-git-feature-stock-inventor-c4ad68-gusta3108-labs-projects.vercel.app'), true);
  assert.equal(isAllowedOrigin('https://local-git-fix-audio-test-gusta3108-labs-projects.vercel.app'), true);
});

test('rejects unrelated domains and lookalike origins', () => {
  assert.equal(isAllowedOrigin('https://evil.example'), false);
  assert.equal(isAllowedOrigin('https://local-git-preview-attacker.vercel.app'), false);
  assert.equal(isAllowedOrigin('https://local-git-preview-gusta3108-labs-projects.vercel.app.attacker.example'), false);
  assert.equal(isAllowedOrigin('http://local-git-preview-gusta3108-labs-projects.vercel.app'), false);
  assert.equal(isAllowedOrigin(''), false);
  assert.equal(isAllowedOrigin(null), false);
});
