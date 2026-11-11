const express = require('express');
const crypto = require('node:crypto');
const { canTransitionOrderStatus, canRejectOrder } = require('./lib/order-status');
const cors = require('cors');
const admin = require('firebase-admin');
const {
  MercadoPagoConfig,
  Preference,
  Payment,
  WebhookSignatureValidator,
  InvalidWebhookSignatureError
} = require('mercadopago');

const app = express();
app.use(cors({
  origin: ['https://masayfantasias.com', 'https://www.masayfantasias.com'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key']
}));
app.use(express.json({ limit: '100kb' }));

const mpToken = process.env.MP_ACCESS_TOKEN;
const mpClient = mpToken
  ? new MercadoPagoConfig({ accessToken: mpToken, options: { timeout: 10000 } })
  : null;

let firestore = null;
let firebaseAuth = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (serviceAccount.project_id !== 'masayfantasias') {
      throw new Error('La cuenta de servicio no pertenece al proyecto Firebase esperado.');
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id
    });
    firestore = admin.firestore();
    firebaseAuth = admin.auth();
  }
} catch (error) {
  console.error('No se pudo inicializar Firebase Admin. Revisá FIREBASE_SERVICE_ACCOUNT_JSON.');
}

function requireFirebaseServices(res) {
  if (!firestore || !firebaseAuth) {
    res.status(503).json({ success: false, error: 'Firebase Admin no está configurado en el servidor.' });
    return false;
  }
  return true;
}

function requireServices(res) {
  if (!mpClient) {
    res.status(503).json({ success: false, error: 'Mercado Pago no está configurado en el servidor.' });
    return false;
  }
  return requireFirebaseServices(res);
}

async function authenticatedUser(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) throw new Error('AUTH_REQUIRED');
  // Rechaza también sesiones revocadas y usuarios deshabilitados.
  // Los tokens inválidos o vencidos se normalizan para que todas las rutas respondan 401.
  let decoded;
  try {
    decoded = await firebaseAuth.verifyIdToken(header.slice(7), true);
  } catch (_error) {
    throw new Error('AUTH_REQUIRED');
  }
  if (!decoded.email) throw new Error('AUTH_EMAIL_REQUIRED');
  return decoded;
}

async function authenticatedAdmin(req) {
  const user = await authenticatedUser(req);
  const adminSnap = await firestore.collection('administradores').doc(user.email).get();
  if (!adminSnap.exists) throw new Error('ADMIN_REQUIRED');
  return user;
}

const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function checkoutIdempotency(req, user, items, order, paymentMethod) {
  const suppliedKey = req.get('Idempotency-Key');
  const key = suppliedKey || crypto.randomUUID(); // Compatibilidad con clientes antiguos.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new Error('IDEMPOTENCY_KEY_INVALID');
  }
  const documentId = crypto.createHash('sha256').update(user.uid + ':' + key).digest('hex');
  const requestHash = crypto.createHash('sha256')
    .update(JSON.stringify({ paymentMethod, items, order }))
    .digest('hex');
  return { ref: firestore.collection('checkout_requests').doc(documentId), requestHash };
}
const stockRequirements = items => {
  const totals = new Map();
  for (const item of items) {
    const productId = String(item.stockProductId || '');
    if (!productId) continue;
    totals.set(productId, (totals.get(productId) || 0) + Number(item.qty));
  }
  return [...totals.entries()].map(([productId, qty]) => ({ productId, qty }));
};

async function reserveInventory(transaction, items) {
  const requirements = stockRequirements(items);
  const refs = requirements.map(item => firestore.collection('productos').doc(item.productId));
  const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
  requirements.forEach((item, index) => {
    const snap = snapshots[index];
    if (!snap.exists) throw new Error('Uno de los productos ya no existe.');
    const product = snap.data();
    // La existencia de stockQuantity también identifica inventario histórico:
    // no dejar que un flag desactivado saltee reservas o ventas tardías.
    if (product.stockManaged !== true && !Object.prototype.hasOwnProperty.call(product, 'stockQuantity')) return;
    const quantity = Number(product.stockQuantity ?? 0);
    const reserved = Number(product.stockReserved ?? 0);
    // Ante datos corruptos, fallar de forma segura: nunca interpretar NaN como stock libre.
    if (!Number.isSafeInteger(quantity) || quantity < 0
      || !Number.isSafeInteger(reserved) || reserved < 0 || reserved > quantity) {
      throw new Error('El inventario de ' + String(product.name || product.nombre || 'un producto') + ' tiene cantidades inválidas. Revisalo desde administración.');
    }
    const available = quantity - reserved;
    if (!Number.isSafeInteger(item.qty) || item.qty < 1 || item.qty > available) {
      const productName = String(product.name || product.nombre || 'Producto');
      throw new Error('STOCK_INSUFFICIENT:' + productName + ':' + available);
    }
    transaction.update(refs[index], { stockReserved: reserved + item.qty });
  });
  return requirements;
}

async function releasePendingInventory(pendingRef) {
  return firestore.runTransaction(async transaction => {
    const pendingSnap = await transaction.get(pendingRef);
    if (!pendingSnap.exists) return false;
    const pending = pendingSnap.data();
    if (pending.inventoryReleased === true) return false;
    const requirements = stockRequirements(pending.order?.items || []);
    const refs = requirements.map(item => firestore.collection('productos').doc(item.productId));
    const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
    requirements.forEach((item, index) => {
      const snap = snapshots[index];
      if (!snap.exists) throw new Error('No se puede liberar la reserva: falta un producto asociado al pago pendiente.');
      const product = snap.data();
      // Los productos legacy sin stock administrado nunca reservaron unidades.
      // No exigir ni descontar una reserva que no existió.
      if (product.stockManaged !== true && !Object.prototype.hasOwnProperty.call(product, 'stockQuantity')) return;
      const reserved = Number(product.stockReserved ?? 0);
      // Nunca reducir a cero silenciosamente: eso podría liberar unidades de otro pedido.
      if (!Number.isSafeInteger(reserved) || reserved < item.qty) {
        throw new Error('No coincide el inventario reservado para liberar el pago pendiente.');
      }
      transaction.update(refs[index], { stockReserved: reserved - item.qty });
    });
    transaction.update(pendingRef, {
      inventoryReleased: true,
      inventoryReleasedAt: admin.firestore.FieldValue.serverTimestamp(),
      // Guardar la fecha original para auditoría y quitar expiresAt del índice
      // de vencimientos: el documento sigue disponible para verificar pagos tardíos.
      reservationExpiresAt: pending.expiresAt || null,
      expiresAt: admin.firestore.FieldValue.delete()
    });
    return true;
  });
}

async function completeInventorySale(transaction, items, hasReservation = false) {
  const requirements = stockRequirements(items);
  const refs = requirements.map(item => firestore.collection('productos').doc(item.productId));
  const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
  requirements.forEach((item, index) => {
    const snap = snapshots[index];
    if (!snap.exists) throw new Error('El producto asociado al pedido ya no existe.');
    const product = snap.data();
    // Los productos legacy sin inventario administrado no reservaron ni deben consumir stock.
    if (product.stockManaged !== true && !Object.prototype.hasOwnProperty.call(product, 'stockQuantity')) return;
    const quantity = Number(product.stockQuantity ?? 0);
    const reserved = Number(product.stockReserved ?? 0);
    // La integridad del contador se valida antes de calcular disponibilidad o consumir reservas.
    if (hasReservation && (!Number.isSafeInteger(reserved) || reserved < item.qty)) {
      throw new Error('La reserva de inventario no coincide con el pedido.');
    }
    if (!Number.isSafeInteger(quantity) || quantity < 0
      || !Number.isSafeInteger(reserved) || reserved < 0 || reserved > quantity) {
      throw new Error('El inventario del producto tiene cantidades inválidas. Revisalo desde administración.');
    }
    if (!hasReservation && quantity - reserved < item.qty) {
      throw new Error('STOCK_INSUFFICIENT:' + String(product.name || product.nombre || 'Producto') + ':' + Math.max(0, quantity - reserved));
    }
    transaction.update(refs[index], {
      stockQuantity: quantity - item.qty,
      stockReserved: hasReservation ? reserved - item.qty : reserved
    });
  });
  return requirements;
}

function stockErrorResponse(error, res) {
  if (!String(error.message || '').startsWith('STOCK_INSUFFICIENT:')) return false;
  const message = String(error.message);
  const separator = message.lastIndexOf(':');
  const productName = message.slice('STOCK_INSUFFICIENT:'.length, separator);
  const available = message.slice(separator + 1);
  res.status(409).json({
    success: false,
    code: 'STOCK_INSUFFICIENT',
    error: 'Stock insuficiente de ' + productName + '. Solo quedan ' + available + ' unidades disponibles.',
    available: Number(available)
  });
  return true;
}


async function priceCartItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) {
    throw new Error('El carrito no es válido.');
  }

  const optionsSnapshot = await firestore.collection('opcionales').get();
  const optionsByName = new Map();
  optionsSnapshot.forEach(doc => {
    const data = doc.data();
    if (data.activo === false) return;
    const key = String(data.name || data.nombre || '').trim().toLowerCase();
    if (!key) return;
    // El carrito actual identifica opcionales por nombre. Si hay nombres repetidos,
    // no se puede determinar el precio correcto de forma inequívoca: se rechaza.
    if (optionsByName.has(key)) throw new Error('Hay opcionales con nombres repetidos. Contactá al administrador para corregir el catálogo.');
    optionsByName.set(key, data);
  });

  const pricedItems = [];
  for (const item of items) {
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new Error('Cantidad de producto inválida.');

    let unitPrice = 0;
    let name = '';
    let description = String(item.description || '').slice(0, 500);
    let itemId = String(item.id || '');

    if (item.bannerId) {
      const bannerSnap = await firestore.collection('banners').doc(String(item.bannerId)).get();
      if (!bannerSnap.exists) throw new Error('La promoción ya no está disponible.');
      const banner = bannerSnap.data();
      if (!banner.productId) throw new Error('La promoción no tiene un producto asociado.');
      const promoProductSnap = await firestore.collection('productos').doc(String(banner.productId)).get();
      if (!promoProductSnap.exists || promoProductSnap.data().activo === false) {
        throw new Error('El producto de esta promoción ya no está disponible.');
      }
      unitPrice = money(banner.promoPrice);
      name = String(banner.title || promoProductSnap.data().name || promoProductSnap.data().nombre || '').slice(0, 160);
      if (!(unitPrice > 0) || !name) throw new Error('Precio o nombre de promoción inválido.');
      itemId = 'promo_' + bannerSnap.id;
      item.stockProductId = bannerSnap.data().productId;
    } else {
      if (!itemId || itemId.startsWith('banner_')) throw new Error('No se pudo identificar un producto del carrito.');
      const productSnap = await firestore.collection('productos').doc(itemId).get();
      if (!productSnap.exists) throw new Error('Uno de los productos ya no existe.');
      const product = productSnap.data();
      item.stockProductId = itemId;
      if (product.activo === false) throw new Error('Uno de los productos no está disponible.');
      const basePrice = money(product.price ?? product.precio ?? 0);
      const discount = Number(product.discount || 0);
      if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
        throw new Error('El descuento de un producto no es válido.');
      }
      if (!(basePrice > 0)) throw new Error('Precio de producto inválido.');
      unitPrice = discount > 0 ? Math.round(basePrice - (basePrice * discount / 100)) : basePrice;
      name = String(product.name || product.nombre || '').slice(0, 160);
      const selectedOptions = String(item.options || '').split(',').map(v => v.trim()).filter(Boolean);
      for (const optionName of selectedOptions) {
        const option = optionsByName.get(optionName.toLowerCase());
        if (!option || option.activo === false) throw new Error('Uno de los opcionales ya no está disponible.');
        unitPrice += money(option.price ?? option.precio ?? 0);
      }
      unitPrice = money(unitPrice);
      if (!name || !(unitPrice > 0)) throw new Error('Precio de producto inválido.');
    }

    // El navegador no decide el precio final: se compara con el catálogo del servidor.
    if (money(item.price) !== unitPrice) throw new Error('El precio de un producto cambió. Actualizá el carrito e intentá nuevamente.');
    pricedItems.push({
      id: itemId,
      stockProductId: item.stockProductId || null,
      name,
      price: unitPrice,
      qty,
      options: String(item.options || '').slice(0, 300),
      description
    });
  }
  return pricedItems;
}

function validWebhookSignature(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return false;
  try {
    // Validador oficial: respeta la firma original y la tolerancia temporal.
    WebhookSignatureValidator.validate({
      xSignature: req.get('x-signature'),
      xRequestId: req.get('x-request-id'),
      dataId: req.query['data.id'],
      secret,
      toleranceSeconds: 300
    });
    return true;
  } catch (error) {
    if (!(error instanceof InvalidWebhookSignatureError)) {
      console.error('Error interno validando firma del webhook:', error.message);
    }
    return false;
  }
}

async function registerApprovedPayment(paymentId, expectedReference, userUid) {
  const paymentClient = new Payment(mpClient);
  const payment = await paymentClient.get({ id: String(paymentId) });
  const reference = String(payment.external_reference || '');
  if (!reference || reference !== String(expectedReference || '')) {
    return { verified: false, reason: 'La referencia del pago no coincide.' };
  }

  const pendingRef = firestore.collection('pagos_pendientes').doc(reference);
  const orderRef = firestore.collection('pedidos').doc(reference);
  const pendingSnap = await pendingRef.get();

  if (!pendingSnap.exists) {
    const existingOrder = await orderRef.get();
    if (existingOrder.exists
      && String(existingOrder.data().paymentId) === String(paymentId)
      && (!userUid || existingOrder.data().userEmail === (await firebaseAuth.getUser(userUid)).email)) {
      return { verified: true, alreadyRegistered: true };
    }
    return { verified: false, reason: 'No se encontró el pedido pendiente asociado al pago.' };
  }

  const pending = pendingSnap.data();
  if (userUid && pending.uid !== userUid) return { verified: false, reason: 'El pago no pertenece a esta cuenta.' };
  if (payment.status !== 'approved') {
    return { verified: false, status: payment.status || 'unknown' };
  }
  if (payment.currency_id !== 'ARS' || money(payment.transaction_amount) !== money(pending.total)) {
    return { verified: false, reason: 'El importe o la moneda del pago no coincide con el pedido.' };
  }
  if (!pending.preferenceId || !payment.preference_id || String(payment.preference_id) !== String(pending.preferenceId)) {
    return { verified: false, reason: 'La preferencia del pago no coincide con el pedido.' };
  }
  if (payment.metadata?.user_uid && String(payment.metadata.user_uid) !== String(pending.uid)) {
    return { verified: false, reason: 'La cuenta asociada al pago no coincide con el pedido.' };
  }

  try {
    await firestore.runTransaction(async transaction => {
      const [freshPending, existingOrder] = await Promise.all([
        transaction.get(pendingRef),
        transaction.get(orderRef)
      ]);
      if (existingOrder.exists) {
        if (String(existingOrder.data().paymentId) !== String(paymentId)) {
          throw new Error('La referencia ya fue utilizada por otro pago.');
        }
        return;
      }
      if (!freshPending.exists) throw new Error('El pedido pendiente ya no existe.');
      const data = freshPending.data();
      await completeInventorySale(transaction, data.order.items, data.inventoryReleased !== true);
      transaction.set(orderRef, {
        ...data.order,
        userEmail: data.userEmail,
        uid: data.uid,
        status: 'nuevo',
        paymentMethod: 'mercadopago',
        paymentId: String(paymentId),
        paymentStatus: 'approved',
        inventoryCommitted: true,
        createdAt: new Date().toISOString()
      });
      transaction.delete(pendingRef);
    });
    return { verified: true, alreadyRegistered: false };
  } catch (registrationError) {
    // El pago ya fue validado directamente con Mercado Pago. Si la reserva venció
    // y otro cliente consumió el stock, registrar una incidencia durable en vez
    // de dejar el webhook reintentando sin que administración pueda verla.
    if (!String(registrationError.message || '').startsWith('STOCK_INSUFFICIENT:')) {
      throw registrationError;
    }
    const incidentRef = firestore.collection('incidencias_pagos').doc(reference);
    await firestore.runTransaction(async transaction => {
      const [freshPending, existingOrder, incidentSnap] = await Promise.all([
        transaction.get(pendingRef),
        transaction.get(orderRef),
        transaction.get(incidentRef)
      ]);
      if (existingOrder.exists) {
        if (String(existingOrder.data().paymentId) !== String(paymentId)) {
          throw new Error('La referencia ya fue utilizada por otro pago.');
        }
        return;
      }
      if (incidentSnap.exists) {
        if (String(incidentSnap.data().paymentId) !== String(paymentId)) {
          throw new Error('La incidencia ya está asociada a otro pago.');
        }
        return;
      }
      if (!freshPending.exists) throw new Error('No se encontró el pedido pendiente para registrar la incidencia.');
      const data = freshPending.data();
      transaction.create(incidentRef, {
        type: 'approved_payment_stock_unavailable',
        status: 'needs_admin_review',
        externalReference: reference,
        paymentId: String(paymentId),
        paymentStatus: 'approved',
        total: data.total,
        currency: 'ARS',
        uid: data.uid,
        userEmail: data.userEmail,
        order: data.order,
        stockError: registrationError.message,
        reservationReleased: data.inventoryReleased === true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      transaction.update(pendingRef, {
        paymentApprovedNeedsReview: true,
        paymentApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
        paymentId: String(paymentId),
        paymentIncidentId: reference
      });
    });
    return { verified: true, alreadyRegistered: false, needsAdminReview: true };
  }
}

app.post('/api/internal/release-expired-inventory', async (req, res) => {
  const expectedSecret = process.env.INVENTORY_CLEANUP_SECRET;
  if (!expectedSecret || req.get('x-inventory-cleanup-secret') !== expectedSecret) {
    return res.sendStatus(401);
  }
  if (!requireFirebaseServices(res)) return;
  try {
    const now = admin.firestore.Timestamp.now();
    const expired = await firestore.collection('pagos_pendientes')
      .where('expiresAt', '<=', now)
      .limit(100)
      .get();
    let released = 0;
    let failed = 0;
    for (const pendingDoc of expired.docs) {
      if (pendingDoc.data().inventoryReleased === true) continue;
      try {
        if (await releasePendingInventory(pendingDoc.ref)) released += 1;
      } catch (cleanupError) {
        failed += 1;
        // Un registro dañado no debe impedir liberar las demás reservas vencidas.
        console.error('No se pudo liberar una reserva vencida:', pendingDoc.id, cleanupError.message);
      }
    }
    return res.json({ success: failed === 0, released, failed, checked: expired.size });
  } catch (error) {
    console.error('Error liberando reservas vencidas:', error.message);
    return res.status(500).json({ success: false, error: 'No se pudieron liberar las reservas vencidas.' });
  }
});

app.get('/api/admin/payment-incidents', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    await authenticatedAdmin(req);
    const [paymentIncidents, checkoutIncidents] = await Promise.all([
      firestore.collection('incidencias_pagos').orderBy('createdAt', 'desc').limit(50).get(),
      firestore.collection('incidencias_checkout').orderBy('createdAt', 'desc').limit(50).get()
    ]);
    const incidents = [
      ...paymentIncidents.docs.map(doc => ({ id: doc.id, ...doc.data() })),
      ...checkoutIncidents.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    ].sort((a, b) => {
      const toMillis = value => value?.toMillis ? value.toMillis() : (value ? new Date(value).getTime() : 0);
      return toMillis(b.createdAt) - toMillis(a.createdAt);
    }).slice(0, 50);
    return res.json({ success: true, incidents });
  } catch (error) {
    const authError = ['AUTH_REQUIRED', 'AUTH_EMAIL_REQUIRED'].includes(error.message) || String(error.code || '').startsWith('auth/');
    const adminError = error.message === 'ADMIN_REQUIRED';
    console.error('Error consultando incidencias de pago:', error.message);
    return res.status(authError ? 401 : adminError ? 403 : 500).json({
      success: false,
      error: authError ? 'La sesión expiró. Volvé a iniciar sesión.'
        : adminError ? 'No tenés permisos para consultar incidencias.'
        : 'No se pudieron consultar las incidencias de pago.'
    });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mercadoPagoConfigured: Boolean(mpClient),
    firebaseConfigured: Boolean(firestore && firebaseAuth),
    webhookSecretConfigured: Boolean(process.env.MP_WEBHOOK_SECRET)
  });
});

app.post('/api/admin/test-order', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    const adminUser = await authenticatedAdmin(req);
    const orderRef = firestore.collection('pedidos').doc();
    const createdAt = new Date().toISOString();
    await orderRef.create({
      esPrueba: true,
      testType: 'audio',
      clientName: 'PRUEBA DE AUDIO',
      clientPhone: '—',
      address: 'Pedido ficticio de administración',
      notes: 'ESTE PEDIDO ES UNA PRUEBA. No corresponde a una venta ni genera cobros.',
      items: [{ id: 'test-audio', name: 'Prueba de notificación', price: 0, qty: 1, options: '', description: 'Pedido ficticio para comprobar recepción y audio.' }],
      total: 0,
      uid: adminUser.uid,
      status: 'nuevo',
      paymentMethod: 'prueba',
      paymentStatus: 'not_applicable',
      createdAt
    });
    return res.status(201).json({ success: true, order_id: orderRef.id, esPrueba: true });
  } catch (error) {
    const authError = ['AUTH_REQUIRED', 'AUTH_EMAIL_REQUIRED'].includes(error.message) || String(error.code || '').startsWith('auth/');
    const adminError = error.message === 'ADMIN_REQUIRED';
    console.error('Error creando pedido de prueba:', error.message);
    return res.status(authError ? 401 : adminError ? 403 : 500).json({
      success: false,
      error: authError ? 'La sesión expiró. Volvé a iniciar sesión.'
        : adminError ? 'No tenés permisos para realizar esta prueba.'
        : 'No se pudo crear el pedido de prueba.'
    });
  }
});

app.post('/api/admin/orders/:orderId/status', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    await authenticatedAdmin(req);
    const orderId = String(req.params.orderId || '');
    const newStatus = String(req.body?.status || '');
    const allowed = ['nuevo', 'preparacion', 'listo', 'finalizado', 'rechazado'];
    if (!/^[A-Za-z0-9_-]{1,150}$/.test(orderId) || !allowed.includes(newStatus)) {
      return res.status(400).json({ success: false, error: 'Pedido o estado inválido.' });
    }
    const orderRef = firestore.collection('pedidos').doc(orderId);
    await firestore.runTransaction(async transaction => {
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists) throw new Error('ORDER_NOT_FOUND');
      const order = orderSnap.data();
      const currentStatus = String(order.status || 'nuevo');
      if (!canTransitionOrderStatus(currentStatus, newStatus)) {
        throw new Error('INVALID_STATUS_TRANSITION');
      }
      if (currentStatus === newStatus) return;
      if (newStatus === 'rechazado' && !canRejectOrder(order)) {
        throw new Error('PAYMENT_REFUND_REQUIRED');
      }
      if (newStatus === 'rechazado'
        && order.inventoryCommitted === true && order.inventoryRestored !== true) {
        const requirements = stockRequirements(order.items || []);
        const refs = requirements.map(item => firestore.collection('productos').doc(item.productId));
        const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
        requirements.forEach((item, index) => {
          const snap = snapshots[index];
          if (!snap.exists) throw new Error('No se puede restaurar el inventario: falta un producto asociado al pedido.');
          const product = snap.data();
          if (product.stockManaged !== true && !Object.prototype.hasOwnProperty.call(product, 'stockQuantity')) return;
          const quantity = Number(product.stockQuantity ?? 0);
          const reserved = Number(product.stockReserved ?? 0);
          if (!Number.isSafeInteger(quantity) || quantity < 0
            || !Number.isSafeInteger(reserved) || reserved < 0 || reserved > quantity
            || !Number.isSafeInteger(item.qty) || item.qty < 1
            || !Number.isSafeInteger(quantity + item.qty)) {
            throw new Error('No se puede restaurar el inventario: las cantidades del producto son inválidas.');
          }
          transaction.update(refs[index], { stockQuantity: quantity + item.qty });
        });
        transaction.update(orderRef, { status: newStatus, inventoryRestored: true, inventoryRestoredAt: new Date().toISOString() });
      } else {
        transaction.update(orderRef, { status: newStatus });
      }
    });
    return res.json({ success: true, order_id: orderId, status: newStatus });
  } catch (error) {
    if (error.message === 'ORDER_NOT_FOUND') return res.status(404).json({ success: false, error: 'El pedido no existe.' });
    if (error.message === 'INVALID_STATUS_TRANSITION') return res.status(409).json({ success: false, error: 'Ese cambio de estado no está permitido. Los pedidos entregados o rechazados no se pueden reabrir ni rechazar nuevamente.' });
    if (error.message === 'PAYMENT_REFUND_REQUIRED') return res.status(409).json({ success: false, error: 'Este pedido fue cobrado con Mercado Pago. Primero realizá la devolución desde Mercado Pago y esperá que el pedido muestre DEVUELTO; recién entonces podrás rechazarlo y devolver el stock. Si figura CONTRACARGO, requiere revisión manual.' });
    if (error.message === 'ADMIN_REQUIRED') return res.status(403).json({ success: false, error: 'No tenés permisos para modificar pedidos.' });
    if (error.message === 'AUTH_REQUIRED' || error.message === 'AUTH_EMAIL_REQUIRED') return res.status(401).json({ success: false, error: 'La sesión expiró. Volvé a iniciar sesión.' });
    console.error('Error actualizando estado del pedido:', error.message);
    return res.status(500).json({ success: false, error: 'No se pudo actualizar el pedido.' });
  }
});

app.post('/api/admin/orders/:orderId/delete', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    await authenticatedAdmin(req);
    const orderId = String(req.params.orderId || '');
    if (!/^[A-Za-z0-9_-]{1,150}$/.test(orderId)) {
      return res.status(400).json({ success: false, error: 'Pedido inválido.' });
    }
    const orderRef = firestore.collection('pedidos').doc(orderId);
    await firestore.runTransaction(async transaction => {
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists) throw new Error('ORDER_NOT_FOUND');
      const order = orderSnap.data();
      if (order.inventoryCommitted === true && order.inventoryRestored !== true) {
        throw new Error('INVENTORY_NOT_RESTORED');
      }
      transaction.delete(orderRef);
    });
    return res.json({ success: true, order_id: orderId });
  } catch (error) {
    if (error.message === 'ORDER_NOT_FOUND') return res.status(404).json({ success: false, error: 'El pedido no existe.' });
    if (error.message === 'INVENTORY_NOT_RESTORED') return res.status(409).json({ success: false, error: 'Primero rechazá el pedido para devolver las unidades al inventario.' });
    if (error.message === 'ADMIN_REQUIRED') return res.status(403).json({ success: false, error: 'No tenés permisos para eliminar pedidos.' });
    if (error.message === 'AUTH_REQUIRED' || error.message === 'AUTH_EMAIL_REQUIRED') return res.status(401).json({ success: false, error: 'La sesión expiró. Volvé a iniciar sesión.' });
    console.error('Error eliminando pedido:', error.message);
    return res.status(500).json({ success: false, error: 'No se pudo eliminar el pedido.' });
  }
});

app.post('/api/pedidos/efectivo', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    const user = await authenticatedUser(req);
    const storeSnap = await firestore.collection('config').doc('local').get();
    if (storeSnap.exists && storeSnap.data().abierto === false) {
      return res.status(409).json({ success: false, error: 'El local está cerrado y no recibe pedidos.' });
    }
    const { items, order } = req.body || {};
    if (!order || typeof order !== 'object') {
      return res.status(400).json({ success: false, error: 'Datos del pedido incompletos.' });
    }
    const clientName = String(order.clientName || '').trim().slice(0, 120);
    const clientPhone = String(order.clientPhone || '').trim().slice(0, 40);
    const address = String(order.address || '').trim().slice(0, 300);
    const notes = String(order.notes || '').trim().slice(0, 1000);
    if (!clientName || !clientPhone || !address) {
      return res.status(400).json({ success: false, error: 'Completá nombre, teléfono y dirección.' });
    }
    const pricedItems = await priceCartItems(items);
    const total = money(pricedItems.reduce((sum, item) => sum + item.price * item.qty, 0));
    const orderData = { clientName, clientPhone, address, notes, items: pricedItems, total };
    const idempotency = checkoutIdempotency(req, user, pricedItems, orderData, 'efectivo');
    const orderRef = firestore.collection('pedidos').doc();
    let finalOrderId = orderRef.id;
    let replayed = false;
    await firestore.runTransaction(async transaction => {
      const idempotencySnap = await transaction.get(idempotency.ref);
      if (idempotencySnap.exists) {
        const previous = idempotencySnap.data();
        if (previous.requestHash !== idempotency.requestHash || previous.paymentMethod !== 'efectivo') {
          throw new Error('IDEMPOTENCY_KEY_REUSED');
        }
        if (previous.status === 'completed' && previous.orderId) {
          finalOrderId = previous.orderId;
          replayed = true;
          return;
        }
        if (previous.status === 'processing') throw new Error('IDEMPOTENCY_PROCESSING');
      }
      await completeInventorySale(transaction, pricedItems, false);
      transaction.create(orderRef, {
        ...orderData,
        uid: user.uid,
        userEmail: user.email,
        status: 'nuevo',
        paymentMethod: 'efectivo',
        paymentStatus: 'pending',
        inventoryCommitted: true,
        createdAt: new Date().toISOString()
      });
      transaction.set(idempotency.ref, {
        uid: user.uid,
        paymentMethod: 'efectivo',
        requestHash: idempotency.requestHash,
        orderId: orderRef.id,
        status: 'completed',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    return res.status(replayed ? 200 : 201).json({ success: true, order_id: finalOrderId, replayed });
  } catch (error) {
    const authError = ['AUTH_REQUIRED', 'AUTH_EMAIL_REQUIRED'].includes(error.message);
    console.error('Error registrando pedido en efectivo:', error.message);
    if (error.message === 'IDEMPOTENCY_KEY_INVALID') return res.status(400).json({ success: false, error: 'La clave del intento de compra no es válida.' });
    if (error.message === 'IDEMPOTENCY_KEY_REUSED') return res.status(409).json({ success: false, error: 'Este intento de compra ya fue utilizado con otros datos. Volvé a confirmar el pedido.' });
    if (error.message === 'IDEMPOTENCY_PROCESSING') return res.status(409).json({ success: false, error: 'El pedido ya se está registrando. Esperá unos segundos y revisá tus pedidos.' });
    if (stockErrorResponse(error, res)) return;
    return res.status(authError ? 401 : 400).json({
      success: false,
      error: authError ? 'La sesión expiró. Volvé a iniciar sesión.' : error.message
    });
  }
});

app.post('/api/crear-preferencia', async (req, res) => {
  try {
    if (!requireServices(res)) return;
    const user = await authenticatedUser(req);
    const storeSnap = await firestore.collection('config').doc('local').get();
    if (storeSnap.exists && storeSnap.data().abierto === false) {
      return res.status(409).json({ success: false, error: 'El local está cerrado y no recibe pedidos.' });
    }
    const { items, order } = req.body || {};
    if (!order || typeof order !== 'object') return res.status(400).json({ success: false, error: 'Datos del pedido incompletos.' });

    const clientName = String(order.clientName || '').trim().slice(0, 120);
    const clientPhone = String(order.clientPhone || '').trim().slice(0, 40);
    const address = String(order.address || '').trim().slice(0, 300);
    const notes = String(order.notes || '').trim().slice(0, 1000);
    if (!clientName || !clientPhone || !address) {
      return res.status(400).json({ success: false, error: 'Completá nombre, teléfono y dirección.' });
    }

    const pricedItems = await priceCartItems(items);
    const total = money(pricedItems.reduce((sum, item) => sum + item.price * item.qty, 0));
    const orderData = { clientName, clientPhone, address, notes, items: pricedItems, total };
    const idempotency = checkoutIdempotency(req, user, pricedItems, orderData, 'mercadopago');
    const externalReference = crypto.randomUUID();
    const preference = new Preference(mpClient);
    const reservationMinutes = 30;
    const reservationStart = new Date();
    const reservationEnd = new Date(reservationStart.getTime() + reservationMinutes * 60 * 1000);
    const pendingRef = firestore.collection('pagos_pendientes').doc(externalReference);
    let replayedCheckout = null;
    let needsAdminReview = false;

    // La clave y la reserva se registran en una sola transacción. Los reintentos
    // concurrentes no pueden reservar unidades ni crear preferencias duplicadas.
    await firestore.runTransaction(async transaction => {
      needsAdminReview = false;
      const idempotencySnap = await transaction.get(idempotency.ref);
      if (idempotencySnap.exists) {
        const previous = idempotencySnap.data();
        if (previous.requestHash !== idempotency.requestHash || previous.paymentMethod !== 'mercadopago') {
          throw new Error('IDEMPOTENCY_KEY_REUSED');
        }
        if (previous.status === 'completed' && previous.initPoint && previous.externalReference) {
          replayedCheckout = previous;
          return;
        }
        if (previous.status === 'processing') {
          const createdAt = previous.createdAt?.toDate ? previous.createdAt.toDate() : null;
          const ageMs = createdAt ? Date.now() - createdAt.getTime() : 0;
          if (ageMs >= 5 * 60 * 1000) {
            const incidentRef = firestore.collection('incidencias_checkout').doc(idempotency.ref.id);
            const incidentSnap = await transaction.get(incidentRef);
            if (!incidentSnap.exists) {
              transaction.create(incidentRef, {
                type: 'mercadopago_preference_creation_interrupted',
                status: 'needs_admin_review',
                uid: user.uid,
                userEmail: user.email,
                externalReference: previous.externalReference || null,
                checkoutRequestId: idempotency.ref.id,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                description: 'El intento quedó en processing más de cinco minutos. Verificar en Mercado Pago si se creó una preferencia antes de liberar la reserva o reintentar.'
              });
            }
            transaction.update(idempotency.ref, {
              status: 'needs_review',
              needsReviewAt: admin.firestore.FieldValue.serverTimestamp()
            });
            needsAdminReview = true;
            return;
          }
          throw new Error('IDEMPOTENCY_PROCESSING');
        }
        if (previous.status === 'needs_review') {
          needsAdminReview = true;
          return;
        }
      }
      if (needsAdminReview) return;
      await reserveInventory(transaction, pricedItems);
      transaction.create(pendingRef, {
        uid: user.uid,
        userEmail: user.email,
        total,
        preferenceId: null,
        initPoint: null,
        order: orderData,
        inventoryReleased: false,
        expiresAt: admin.firestore.Timestamp.fromDate(reservationEnd),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      transaction.set(idempotency.ref, {
        uid: user.uid,
        paymentMethod: 'mercadopago',
        requestHash: idempotency.requestHash,
        externalReference,
        status: 'processing',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    if (needsAdminReview) {
      return res.status(409).json({ success: false, code: 'CHECKOUT_NEEDS_REVIEW', error: 'Este intento de pago requiere revisión administrativa. No vuelvas a pagar ni generes otro intento hasta que lo revisemos.' });
    }

    if (replayedCheckout) {
      return res.json({
        success: true,
        init_point: replayedCheckout.initPoint,
        external_reference: replayedCheckout.externalReference,
        replayed: true
      });
    }

    try {
      const result = await preference.create({
        body: {
          items: pricedItems.map(item => ({
            title: item.name,
            quantity: item.qty,
            unit_price: item.price,
            currency_id: 'ARS'
          })),
          payer: { email: user.email, name: clientName, phone: { number: clientPhone } },
          external_reference: externalReference,
          metadata: { external_reference: externalReference, user_uid: user.uid },
          expiration_date_from: reservationStart.toISOString(),
          expiration_date_to: reservationEnd.toISOString(),
          back_urls: {
            success: 'https://masayfantasias.com/?mp_return=1',
            failure: 'https://masayfantasias.com/?mp_return=1',
            pending: 'https://masayfantasias.com/?mp_return=1'
          },
          notification_url: 'https://masayfantasias-webhook-2026.onrender.com/api/webhook',
          auto_return: 'approved'
        }
      });

      // El enlace solo se entrega después de persistir el ID de preferencia.
      await pendingRef.update({
        preferenceId: String(result.id),
        initPoint: result.init_point,
        preferenceCreatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await idempotency.ref.update({
        status: 'completed',
        initPoint: result.init_point,
        preferenceId: String(result.id),
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.json({ success: true, init_point: result.init_point, external_reference: externalReference, reservation_expires_at: reservationEnd.toISOString(), replayed: false });
    } catch (preferenceError) {
      // Si Mercado Pago falla, liberar la reserva para no inmovilizar unidades.
      try {
        await releasePendingInventory(pendingRef);
      } catch (cleanupError) {
        console.error('No se pudo liberar la reserva tras fallar la preferencia:', cleanupError.message);
      }
      try {
        await idempotency.ref.update({
          status: 'failed',
          failedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (idempotencyError) {
        console.error('No se pudo actualizar el estado del intento de checkout:', idempotencyError.message);
      }
      throw preferenceError;
    }
  } catch (error) {
    const authError = ['AUTH_REQUIRED', 'AUTH_EMAIL_REQUIRED'].includes(error.message);
    console.error('Error creando preferencia:', error.message);
    if (error.message === 'IDEMPOTENCY_KEY_INVALID') return res.status(400).json({ success: false, error: 'La clave del intento de compra no es válida.' });
    if (error.message === 'IDEMPOTENCY_KEY_REUSED') return res.status(409).json({ success: false, error: 'Este intento de compra ya fue utilizado con otros datos. Volvé a confirmar el pedido.' });
    if (error.message === 'IDEMPOTENCY_PROCESSING') return res.status(409).json({ success: false, error: 'El pago ya se está preparando. Esperá unos segundos antes de volver a intentar.' });
    if (stockErrorResponse(error, res)) return;
    res.status(authError ? 401 : 400).json({ success: false, error: authError ? 'La sesión expiró. Volvé a iniciar sesión.' : error.message });
  }
});

app.post('/api/verificar-pago', async (req, res) => {
  try {
    if (!requireServices(res)) return;
    const user = await authenticatedUser(req);
    const { payment_id: paymentId, external_reference: reference } = req.body || {};
    if (!paymentId || !/^\d{1,30}$/.test(String(paymentId)) || !reference || !/^[0-9a-f-]{36}$/i.test(String(reference))) {
      return res.status(400).json({ verified: false, error: 'Faltan datos válidos para verificar el pago.' });
    }
    const result = await registerApprovedPayment(paymentId, reference, user.uid);
    res.json(result);
  } catch (error) {
    const authError = ['AUTH_REQUIRED', 'AUTH_EMAIL_REQUIRED'].includes(error.message);
    console.error('Error verificando pago:', error.message);
    res.status(authError ? 401 : 500).json({ verified: false, error: authError ? 'La sesión expiró.' : 'No se pudo verificar el pago en este momento.' });
  }
});

async function updateReversedPayment(paymentId, reference, status) {
  const orderRef = firestore.collection('pedidos').doc(reference);
  return firestore.runTransaction(async transaction => {
    const orderSnap = await transaction.get(orderRef);
    if (!orderSnap.exists) return false;
    const order = orderSnap.data();
    // Solo actualizar el pedido si pertenece exactamente al pago consultado en Mercado Pago.
    if (String(order.paymentId || '') !== String(paymentId)) return false;
    if (order.paymentStatus === 'charged_back') return true;
    if (order.paymentStatus === 'refunded' && status !== 'charged_back') return true;
    if (order.paymentStatus !== 'approved') return false;
    transaction.update(orderRef, {
      paymentStatus: status,
      paymentStatusUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return true;
  });
}

app.post('/api/webhook', async (req, res) => {
  try {
    if (!requireServices(res)) return;
    if (!validWebhookSignature(req)) return res.sendStatus(401);
    const type = req.query.type || req.body?.type;
    const paymentId = req.query['data.id'];
    if (type !== 'payment') return res.sendStatus(200);
    if (!paymentId || !/^\d{1,30}$/.test(String(paymentId))) return res.sendStatus(400);

    // El webhook solo es una señal: el estado real se consulta directamente en Mercado Pago.
    const paymentClient = new Payment(mpClient);
    const payment = await paymentClient.get({ id: String(paymentId) });
    const reference = String(payment.external_reference || '');
    if (!reference) return res.sendStatus(200);
    if (payment.status !== 'approved') {
      const paymentStatus = String(payment.status || '');
      if (['cancelled', 'rejected', 'refunded', 'charged_back'].includes(paymentStatus)) {
        await releasePendingInventory(firestore.collection('pagos_pendientes').doc(reference));
      }
      // Una devolución o contracargo posterior a la aprobación debe reflejarse
      // en el pedido existente. No se repone stock automáticamente: el producto
      // puede haber sido preparado o entregado y requiere decisión administrativa.
      if (['refunded', 'charged_back'].includes(paymentStatus)) {
        await updateReversedPayment(paymentId, reference, paymentStatus);
      }
      return res.sendStatus(200);
    }
    const result = await registerApprovedPayment(paymentId, reference, null);
    if (!result.verified) return res.status(500).json({ received: true, processed: false });
    return res.sendStatus(200);
  } catch (error) {
    console.error('Error procesando webhook:', error.message);
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
