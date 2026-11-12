'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');

test('HTTP middleware returns safe JSON errors for rejected requests', async (t) => {
  const server = app.listen(0);
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const corsResponse = await fetch(`${baseUrl}/health`, {
    headers: { Origin: 'https://attacker.example' }
  });
  assert.equal(corsResponse.status, 403);
  assert.match(corsResponse.headers.get('content-type') || '', /application\/json/);
  assert.deepEqual(await corsResponse.json(), {
    success: false,
    error: 'Origen no autorizado.'
  });

  const malformedJsonResponse = await fetch(`${baseUrl}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{'
  });
  assert.equal(malformedJsonResponse.status, 400);
  assert.deepEqual(await malformedJsonResponse.json(), {
    success: false,
    error: 'El cuerpo JSON de la solicitud no es válido.'
  });

  const oversizedResponse = await fetch(`${baseUrl}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: 'x'.repeat(101 * 1024) })
  });
  assert.equal(oversizedResponse.status, 413);
  assert.deepEqual(await oversizedResponse.json(), {
    success: false,
    error: 'La solicitud supera el tamaño permitido.'
  });

  const missingRouteResponse = await fetch(`${baseUrl}/api/ruta-inexistente`);
  assert.equal(missingRouteResponse.status, 404);
  assert.match(missingRouteResponse.headers.get('content-type') || '', /application\\/json/);
  assert.deepEqual(await missingRouteResponse.json(), {
    success: false,
    error: 'La ruta solicitada no existe.'
  });
});
