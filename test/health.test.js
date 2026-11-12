const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');

test('GET /health reports service status without exposing credentials', async (t) => {
  const server = app.listen(0);
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/json/);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.mercadoPagoConfigured, 'boolean');
  assert.equal(typeof body.firebaseConfigured, 'boolean');
  assert.equal(typeof body.webhookSecretConfigured, 'boolean');
  assert.deepEqual(
    Object.keys(body).sort(),
    ['firebaseConfigured', 'mercadoPagoConfigured', 'ok', 'webhookSecretConfigured'].sort()
  );
  assert.doesNotMatch(JSON.stringify(body), /AIza|sk_live|APP_USR-|BEGIN PRIVATE KEY/);
});
