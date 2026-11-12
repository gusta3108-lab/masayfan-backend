'use strict';

async function searchPaymentsByExternalReference({
  accessToken,
  externalReference,
  fetchImpl = globalThis.fetch
}) {
  if (!accessToken) throw new Error('Falta el token de acceso de Mercado Pago.');
  if (!externalReference || typeof externalReference !== 'string') {
    throw new Error('La referencia externa del pago no es válida.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('No está disponible fetch para consultar Mercado Pago.');

  const url = new URL('https://api.mercadopago.com/v1/payments/search');
  url.searchParams.set('sort', 'date_created');
  url.searchParams.set('criteria', 'desc');
  url.searchParams.set('external_reference', externalReference);
  url.searchParams.set('range', 'date_created');
  url.searchParams.set('begin_date', 'NOW-364DAYS');
  url.searchParams.set('end_date', 'NOW');
  url.searchParams.set('limit', '50');
  url.searchParams.set('offset', '0');

  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + accessToken
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    throw new Error('La búsqueda de pagos en Mercado Pago respondió HTTP ' + response.status + '.');
  }

  const body = await response.json();
  if (!body || !Array.isArray(body.results)) {
    throw new Error('Mercado Pago devolvió una respuesta de búsqueda inválida.');
  }
  const results = body.results.filter(payment =>
    payment && String(payment.external_reference || '') === externalReference
  );
  const total = Number(body.paging?.total);
  if (!Number.isSafeInteger(total) || total < 0 || total > body.results.length
    || results.length !== body.results.length) {
    throw new Error('La búsqueda de pagos quedó incompleta o devolvió referencias inconsistentes; no se puede liberar el inventario.');
  }
  return results;
}

module.exports = { searchPaymentsByExternalReference };
