'use strict';

// Keep cards enabled while limiting every new Checkout Pro preference to one payment.
function buildMercadoPagoPaymentMethods() {
  return {
    installments: 1,
    default_installments: 1
  };
}

module.exports = { buildMercadoPagoPaymentMethods };
