'use strict';

const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function validateOffer(order, offeredCourierFee) {
  const total = roundMoney(order?.total);
  const fee = roundMoney(offeredCourierFee);
  if (!Number.isFinite(total) || total <= 0) throw new Error('ORDER_TOTAL_INVALID');
  if (!Number.isFinite(fee) || fee <= 0 || fee > total) throw new Error('COURIER_OFFER_INVALID');
  return { total, fee };
}

// Creates a pending offer. It is not an assignment and does not create earnings.
function buildCourierOffer(order, offeredCourierFee, courierId, adminEmail) {
  const { total, fee } = validateOffer(order, offeredCourierFee);
  if (!/^[a-f0-9]{64}$/.test(String(courierId || ''))) throw new Error('COURIER_ID_INVALID');
  return {
    courierId: String(courierId),
    amount: fee,
    orderTotal: total,
    storeAmount: roundMoney(total - fee),
    status: 'pending',
    offeredBy: String(adminEmail || '').trim().toLowerCase(),
    offeredAt: new Date().toISOString()
  };
}

// Call only inside the Firestore transaction that wins the pending-offer race.
// The accepted amount is copied to the order and must never be recalculated.
function acceptCourierOffer(order, offer) {
  if (!offer || offer.status !== 'pending' || !offer.courierId) throw new Error('OFFER_NOT_AVAILABLE');
  const { total, fee } = validateOffer(order, offer.amount);
  return {
    courierId: String(offer.courierId),
    courierFee: fee,
    storeAmount: roundMoney(total - fee),
    acceptedAt: new Date().toISOString(),
    offerAccepted: true
  };
}

// Earnings are recorded only after delivery. For cash orders the courier
// receives the offered fee from the customer; online earnings are owed by Masay.
function buildCourierEarning(order, offeredCourierFee) {
  const { total, fee } = validateOffer(order, offeredCourierFee);
  const paymentMethod = String(order?.paymentMethod || 'efectivo').trim().toLowerCase();
  const isCash = ['efectivo', 'cash'].includes(paymentMethod);
  return {
    total,
    courierFee: fee,
    storeAmount: roundMoney(total - fee),
    paymentMethod: isCash ? 'efectivo' : paymentMethod,
    earningStatus: isCash ? 'cash_to_collect' : 'online_pending'
  };
}

function summarizeCourierWallet(movements, payouts = []) {
  const entries = Array.isArray(movements) ? movements : [];
  const payments = Array.isArray(payouts) ? payouts : [];
  const amountFor = rows => roundMoney(rows.reduce((sum, row) => sum + Math.max(0, Number(row.amount) || 0), 0));
  const totalEarned = amountFor(entries.filter(entry => ['cash_received', 'online_pending', 'paid'].includes(entry.status)));
  const cashReceived = amountFor(entries.filter(entry => entry.status === 'cash_received'));
  const cashToCollect = amountFor(entries.filter(entry => entry.status === 'cash_to_collect'));
  const onlinePending = amountFor(entries.filter(entry => entry.status === 'online_pending'));
  const paidOut = amountFor(payments.filter(payment => payment.status === 'paid'));
  const balanceToPay = roundMoney(Math.max(0, onlinePending - paidOut));
  return { totalEarned, cashReceived, cashToCollect, onlinePending, paidOut, balanceToPay };
}

module.exports = { buildCourierOffer, acceptCourierOffer, buildCourierEarning, summarizeCourierWallet };
