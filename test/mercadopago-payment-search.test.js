'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchPaymentsByExternalReference } = require('../lib/mercadopago-payment-search');

test('searches Mercado Pago by exact external reference using authenticated API request', async () => {
  let request;
  const results = await searchPaymentsByExternalReference({
    accessToken: 'test-token',
    externalReference: 'ref-123',
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return {
        ok: true,
        json: async () => ({
          paging: { total: 1 },
          results: [
            { id: 456, external_reference: 'ref-123', status: 'approved' }
          ]
        })
      };
    }
  });

  assert.equal(request.url.origin, 'https://api.mercadopago.com');
  assert.equal(request.url.pathname, '/v1/payments/search');
  assert.equal(request.url.searchParams.get('external_reference'), 'ref-123');
  assert.equal(request.url.searchParams.get('sort'), 'date_created');
  assert.equal(request.url.searchParams.get('criteria'), 'desc');
  assert.equal(request.options.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(results, [{ id: 456, external_reference: 'ref-123', status: 'approved' }]);
});

test('returns an empty list only after a successful empty search', async () => {
  const results = await searchPaymentsByExternalReference({
    accessToken: 'test-token',
    externalReference: 'ref-empty',
    fetchImpl: async () => ({ ok: true, json: async () => ({ paging: { total: 0 }, results: [] }) })
  });
  assert.deepEqual(results, []);
});

test('fails closed when Mercado Pago returns a different external reference', async () => {
  await assert.rejects(
    searchPaymentsByExternalReference({
      accessToken: 'test-token',
      externalReference: 'ref-123',
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          paging: { total: 1 },
          results: [{ id: 456, external_reference: 'other-ref', status: 'approved' }]
        })
      })
    }),
    /referencias inconsistentes/
  );
});

test('fails closed when Mercado Pago search is unavailable', async () => {
  await assert.rejects(
    searchPaymentsByExternalReference({
      accessToken: 'test-token',
      externalReference: 'ref-123',
      fetchImpl: async () => ({ ok: false, status: 503 })
    }),
    /HTTP 503/
  );
});

test('fails closed on malformed or incomplete search responses', async () => {
  await assert.rejects(
    searchPaymentsByExternalReference({
      accessToken: 'test-token',
      externalReference: 'ref-123',
      fetchImpl: async () => ({ ok: true, json: async () => ({ results: [], paging: { total: 60 } }) })
    }),
    /paginada/
  );
  await assert.rejects(
    searchPaymentsByExternalReference({
      accessToken: 'test-token',
      externalReference: 'ref-123',
      fetchImpl: async () => ({ ok: true, json: async () => ({}) })
    }),
    /respuesta de búsqueda inválida/
  );
});
