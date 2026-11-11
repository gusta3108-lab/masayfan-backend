'use strict';

const DEFAULT_ENDPOINT = 'https://masayfantasias-webhook-2026.onrender.com/api/internal/release-expired-inventory';

async function releaseExpiredInventory({
  endpoint = process.env.INVENTORY_CLEANUP_URL || DEFAULT_ENDPOINT,
  secret = process.env.INVENTORY_CLEANUP_SECRET,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!secret) throw new Error('Falta configurar INVENTORY_CLEANUP_SECRET.');
  if (typeof fetchImpl !== 'function') throw new Error('Este proceso requiere Node.js 20 o superior.');

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'x-inventory-cleanup-secret': secret },
    // Render Free may need about one minute to wake from idle; allow extra time.
    signal: AbortSignal.timeout(90000)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error('La limpieza de inventario respondió HTTP ' + response.status + ': ' + body.slice(0, 500));
  }

  let result;
  try {
    result = JSON.parse(body);
  } catch (_error) {
    throw new Error('La limpieza de inventario devolvió una respuesta JSON inválida.');
  }
  if (result.truncated === true) {
    throw new Error('La limpieza alcanzó el límite de 1000 reservas por ejecución. Quedan registros por revisar y la próxima ejecución continuará el procesamiento.');
  }
  if (result.success !== true || Number(result.failed || 0) > 0) {
    throw new Error('La limpieza de inventario informó fallas: ' + JSON.stringify(result).slice(0, 500));
  }

  process.stdout.write(body + '\n');
  return { status: response.status, body, result };
}

if (require.main === module) {
  releaseExpiredInventory().catch(error => {
    console.error('Falló la limpieza automática de inventario:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { releaseExpiredInventory };
