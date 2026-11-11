'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { releaseExpiredInventory } = require('./scripts/release-expired-inventory');

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => body };
}

test('requires the cleanup secret before making a request', async () => {
  let called = false;
  await assert.rejects(
    releaseExpiredInventory({ secret: '', fetchImpl: async () => { called = true; } }),
    /Falta configurar INVENTORY_CLEANUP_SECRET/
  );
  assert.equal(called, false);
});

test('posts the secret header and accepts a successful cleanup response', async () => {
  let request;
  const result = await releaseExpiredInventory({
    endpoint: 'https://cleanup.example.test',
    secret: 'test-secret',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, JSON.stringify({ success: true, released: 2, failed: 0, checked: 2 }));
    }
  });

  assert.equal(request.url, 'https://cleanup.example.test');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['x-inventory-cleanup-secret'], 'test-secret');
  assert.equal(result.result.released, 2);
});

test('fails when the backend returns a non-success HTTP status', async () => {
  await assert.rejects(
    releaseExpiredInventory({
      secret: 'test-secret',
      fetchImpl: async () => response(401, 'Unauthorized')
    }),
    /HTTP 401/
  );
});

test('fails when the backend response is not valid JSON', async () => {
  await assert.rejects(
    releaseExpiredInventory({
      secret: 'test-secret',
      fetchImpl: async () => response(200, 'not-json')
    }),
    /JSON inválida/
  );
});

test('fails when the backend reports unsuccessful cleanup or failed records', async () => {
  await assert.rejects(
    releaseExpiredInventory({
      secret: 'test-secret',
      fetchImpl: async () => response(200, JSON.stringify({ success: false, released: 0, failed: 1 }))
    }),
    /informó fallas/
  );
});
