'use strict';

// Business-funded assistance reserve. This module never deducts from a courier's
// agreed remuneration and does not move money between bank accounts.

const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function calculateBusinessContribution({ enabled = false, mode = 'fixed', fixedAmount = 0, percentage = 0, courierFee = 0 } = {}) {
  if (!enabled) return 0;

  const fee = Number(courierFee);
  if (!Number.isFinite(fee) || fee < 0) throw new Error('COURIER_FEE_INVALID');

  if (mode === 'fixed') {
    const amount = Number(fixedAmount);
    if (!Number.isFinite(amount) || amount < 0) throw new Error('FUND_FIXED_AMOUNT_INVALID');
    return roundMoney(amount);
  }

  if (mode === 'percentage') {
    const rate = Number(percentage);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error('FUND_PERCENTAGE_INVALID');
    return roundMoney(fee * rate / 100);
  }

  throw new Error('FUND_MODE_INVALID');
}

function buildBusinessContributionEntry({ orderId, deliveryStatus, courierFee, config, createdAt = new Date().toISOString() } = {}) {
  const id = String(orderId || '').trim();
  if (!id) throw new Error('FUND_ORDER_ID_REQUIRED');
  if (!['delivered', 'entregado', 'finalizado'].includes(String(deliveryStatus || '').toLowerCase())) {
    throw new Error('FUND_ONLY_COMPLETED_DELIVERIES');
  }

  const amount = calculateBusinessContribution({ ...(config || {}), courierFee });
  if (amount <= 0) return null;

  return {
    orderId: id,
    amount,
    currency: 'ARS',
    source: 'business_contribution',
    fundType: 'courier_assistance',
    courierDeduction: 0,
    courierPayoutReduced: false,
    status: 'accrued',
    createdAt
  };
}

module.exports = {
  calculateBusinessContribution,
  buildBusinessContributionEntry
};
