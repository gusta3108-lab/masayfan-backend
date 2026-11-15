'use strict';

const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function optionalMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? roundMoney(amount) : null;
}

function buildMercadoPagoAccounting(payment = {}) {
  const feeDetails = Array.isArray(payment.fee_details)
    ? payment.fee_details.map(item => ({
        type: String(item?.type || 'unknown').slice(0, 80),
        amount: optionalMoney(item?.amount),
        feePayer: item?.fee_payer ? String(item.fee_payer).slice(0, 40) : null
      })).filter(item => item.amount !== null)
    : [];
  const feeTotal = feeDetails.length
    ? roundMoney(feeDetails.reduce((sum, item) => sum + item.amount, 0))
    : null;
  const installmentsValue = Number(payment.installments);

  return {
    grossAmount: optionalMoney(payment.transaction_amount),
    feeTotal,
    feeDetails,
    netReceivedAmount: optionalMoney(payment.transaction_details?.net_received_amount),
    installments: Number.isInteger(installmentsValue) && installmentsValue >= 1 ? installmentsValue : null,
    paymentMethodId: payment.payment_method_id ? String(payment.payment_method_id).slice(0, 80) : null,
    paymentTypeId: payment.payment_type_id ? String(payment.payment_type_id).slice(0, 80) : null,
    approvedAt: payment.date_approved ? String(payment.date_approved).slice(0, 80) : null
  };
}

module.exports = { buildMercadoPagoAccounting };
