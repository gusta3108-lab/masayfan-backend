'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { releaseExpiredInventory } = require('../scripts/release-expired-inventory');

test('requires the cleanup secret', async () => {
  await assert.rejects(
    releaseExpiredInventory({ secret: '', fetchImpl: async () => { throw new Error('fetch must not run'); } }),
    /Falta configurar INVENTORY_CLEANUP_SECRET/
  );
});

test('calls the protected endpoint with the configured secret', async () => {
  let request;
  const result = await releaseExpiredInventory({
    endpoint: 'https://example.test/cleanup',
    secret: 'test-secret',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, text: async () => '{"success":true,"released":2,"failed":0,"checked":2}' };
    }
  });

  assert.equal(request.url, 'https://example.test/cleanup');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['x-inventory-cleanup-secret'], 'test-secret');
  assert.equal(result.status, 200);
  assert.equal(result.result.released, 2);
});

test('fails the job when the backend returns a non-success status', async () => {
  await assert.rejects(
    releaseExpiredInventory({
      secret: 'test-secret',
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' })
    }),
    /HTTP 401/
  );
});

test('fails the job when the backend reports partial cleanup failures with HTTP 200', async () => {
  await assert.rejects(
    releaseExpiredInventory({
      secret: 'test-secret',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => '{"success":false,"released":1,"failed":1,"checked":2}'
      })
    }),
    /informó fallas/
  );
});

test('fails closed when the backend response is not valid JSON', async () => {
  await assert.rejects(
    releaseExpiredInventory({
      secret: 'test-secret',
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'ok' })
    }),
    /JSON inválida/
  );
});
