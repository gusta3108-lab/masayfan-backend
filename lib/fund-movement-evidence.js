'use strict';

function hasRequiredMovementEvidence(type, receiptReference) {
  if (!['bank_deposit', 'assistance'].includes(String(type || ''))) return false;
  return typeof receiptReference === 'string' && receiptReference.trim().length >= 3;
}

function isAssistanceFundEnabled(config) {
  return config?.enabled === true;
}

module.exports = { hasRequiredMovementEvidence, isAssistanceFundEnabled };
