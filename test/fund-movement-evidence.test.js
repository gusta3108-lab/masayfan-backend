'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasRequiredMovementEvidence } = require('../lib/fund-movement-evidence');

test('bank deposits cannot be posted without a receipt reference', () => {
  assert.equal(hasRequiredMovementEvidence('bank_deposit', ''), false);
  assert.equal(hasRequiredMovementEvidence('bank_deposit', '   '), false);
  assert.equal(hasRequiredMovementEvidence('bank_deposit', 'ab'), false);
  assert.equal(hasRequiredMovementEvidence('bank_deposit', 'BANK-OP-123'), true);
  assert.equal(hasRequiredMovementEvidence('bank_deposit', 'https://example.com/receipt/123'), true);
});

test('assistance payments also require supporting evidence', () => {
  assert.equal(hasRequiredMovementEvidence('assistance', ''), false);
  assert.equal(hasRequiredMovementEvidence('assistance', 'REC-2026-11'), true);
});

test('unsupported movement types are never accepted as evidenced movements', () => {
  assert.equal(hasRequiredMovementEvidence('contribution', 'REC-123'), false);
  assert.equal(hasRequiredMovementEvidence('', 'REC-123'), false);
});
