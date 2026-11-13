const express = require('express');
const crypto = require('node:crypto');
const { canTransitionOrderStatus, canTransitionTestOrderStatus, canRejectOrder, isTestOrder } = require('./lib/order-status');
const { requireCustomerAccount } = require('./lib/customer-account');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getMessaging } = require('firebase-admin/messaging');
const {
  MercadoPagoConfig,
  Preference,
  Payment,
  WebhookSignatureValidator,
  InvalidWebhookSignatureError
} = require('mercadopago');

const { isAllowedOrigin } = require('./lib/cors-origin');
const { registerAdminPushToken, removeAdminPushToken, sendAdminOrderPushNotifications } = require('./lib/admin-push-notifications');
const { searchPaymentsByExternalReference } = require('./lib/mercadopago-payment-search');
const { courierDocumentId, normalizeCourier, canTransitionDeliveryStatus, buildCourierOrder, buildCourierWhatsAppUrl, optimizeDeliveryStops, buildGoogleMapsRouteUrl, buildGoogleMapsRouteSegments, buildBatchCourierWhatsAppUrl } = require('./lib/delivery');

const app = express();
app.use(cors({
  origin(origin, callback) {
    if (!origin || isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('Origen no autorizado por CORS'));
  },
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key']
}));
app.use(express.json({ limit: '100kb' }));

const mpToken = process.env.MP_ACCESS_TOKEN;
const mpClient = mpToken
  ? new MercadoPagoConfig({ accessToken: mpToken, options: { timeout: 10000 } })
  : null;

let firestore = null;
let firebaseAuth = null;
let firebaseMessaging = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (serviceAccount.project_id !== 'masayfantasias') {
      throw new Error('La cuenta de servicio no pertenece al proyecto Firebase esperado.');
    }
    const firebaseApp = initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.project_id
    });
    firestore = getFirestore(firebaseApp);
    firebaseAuth = getAuth(firebaseApp);
    firebaseMessaging = getMessaging(firebaseApp);
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

function notifyAdminsNewOrder(orderId, order) {
  if (!firestore || !firebaseMessaging) return;
  void sendAdminOrderPushNotifications({
    firestore,
    messaging: firebaseMessaging,
    orderId,
    order
  }).catch(error => console.error('No se pudieron enviar las alertas de nuevo pedido:', error.message));
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
const { stockRequirements, createInventoryService } = require('./lib/inventory');
const inventoryService = createInventoryService({ getFirestore: () => firestore });
const { reserveInventory, releasePendingInventory, completeInventorySale } = inventoryService;

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

async function registerApprovedPayment(paymentId, expectedReference, userUid, verifiedPayment = null, options = {}) {
  const paymentClient = new Payment(mpClient);
  const payment = verifiedPayment || await paymentClient.get({ id: String(paymentId) });
  const reference = String(payment.external_reference || '');
  if (!reference || reference !== String(expectedReference || '')) {
    return { verified: false, reason: 'La referencia del pago no coincide.' };
  }

  const pendingRef = firestore.collection('pagos_pendientes').doc(reference);
  const orderRef = firestore.collection('pedidos').doc(reference);
  const pendingSnap = await pendingRef.get();

  const validationIncidentRef = firestore.collection('incidencias_pagos')
    .doc(reference + '_' + String(paymentId).replace(/[^A-Za-z0-9_-]/g, '_'));

  async function recordApprovedPaymentValidationIncident(reason, pendingData = null) {
    await firestore.runTransaction(async transaction => {
      const [freshPending, existingOrder, incidentSnap] = await Promise.all([
        transaction.get(pendingRef),
        transaction.get(orderRef),
        transaction.get(validationIncidentRef)
      ]);
      if (existingOrder.exists) {
        if (String(existingOrder.data().paymentId) === String(paymentId)) return;
        throw new Error('La referencia ya fue utilizada por otro pago.');
      }
      const data = freshPending.exists ? freshPending.data() : pendingData;
      const incident = {
        type: data ? 'approved_payment_validation_failed' : 'approved_payment_without_pending_order',
        status: 'needs_admin_review',
        externalReference: reference,
        paymentId: String(paymentId),
        paymentStatus: 'approved',
        total: data?.total ?? null,
        currency: String(payment.currency_id || ''),
        receivedAmount: money(payment.transaction_amount || 0),
        expectedPreferenceId: data?.preferenceId || null,
        receivedPreferenceId: payment.preference_id ? String(payment.preference_id) : null,
        uid: data?.uid || null,
        userEmail: data?.userEmail || null,
        order: data?.order || null,
        reason,
        updatedAt: FieldValue.serverTimestamp()
      };
      if (incidentSnap.exists) {
        if (String(incidentSnap.data().paymentId) !== String(paymentId)) {
          throw new Error('La incidencia ya está asociada a otro pago.');
        }
        transaction.set(validationIncidentRef, incident, { merge: true });
      } else {
        transaction.create(validationIncidentRef, {
          ...incident,
          createdAt: FieldValue.serverTimestamp()
        });
      }
      if (freshPending.exists) {
        transaction.update(pendingRef, {
          paymentApprovedNeedsReview: true,
          paymentApprovedAt: FieldValue.serverTimestamp(),
          paymentId: String(paymentId),
          paymentIncidentId: validationIncidentRef.id
        });
      }
    });
    return { verified: false, needsAdminReview: true, reason };
  }

  if (!pendingSnap.exists) {
    const existingOrder = await orderRef.get();
    if (existingOrder.exists
      && String(existingOrder.data().paymentId) === String(paymentId)
      && (!userUid || existingOrder.data().userEmail === (await firebaseAuth.getUser(userUid)).email)) {
      return { verified: true, alreadyRegistered: true };
    }
    if (payment.status === 'approved') {
      return recordApprovedPaymentValidationIncident('No se encontró el pedido pendiente asociado al pago.');
    }
    return { verified: false, reason: 'No se encontró el pedido pendiente asociado al pago.' };
  }

  const pending = pendingSnap.data();
  if (userUid && pending.uid !== userUid) return { verified: false, reason: 'El pago no pertenece a esta cuenta.' };
  if (payment.status !== 'approved') {
    return { verified: false, status: payment.status || 'unknown' };
  }

  let validationFailure = null;
  if (payment.currency_id !== 'ARS' || money(payment.transaction_amount) !== money(pending.total)) {
    validationFailure = 'El importe o la moneda del pago no coincide con el pedido.';
  } else if (!pending.preferenceId || !payment.preference_id || String(payment.preference_id) !== String(pending.preferenceId)) {
    validationFailure = 'La preferencia del pago no coincide con el pedido.';
  } else if (payment.metadata?.user_uid && String(payment.metadata.user_uid) !== String(pending.uid)) {
    validationFailure = 'La cuenta asociada al pago no coincide con el pedido.';
  }
  if (validationFailure) return recordApprovedPaymentValidationIncident(validationFailure, pending);

  try {
    let orderCreated = false;
    await firestore.runTransaction(async transaction => {
      orderCreated = false;
      const [freshPending, existingOrder, validationIncident] = await Promise.all([
        transaction.get(pendingRef),
        transaction.get(orderRef),
        transaction.get(validationIncidentRef)
      ]);
      if (existingOrder.exists) {
        if (String(existingOrder.data().paymentId) !== String(paymentId)) {
          throw new Error('La referencia ya fue utilizada por otro pago.');
        }
        return;
      }
      if (!freshPending.exists) throw new Error('El pedido pendiente ya no existe.');
      const data = freshPending.data();
      // An expired reservation cannot be converted into a sale after payment.
      // The payment must be reconciled separately; never consume unreserved stock.
      if (data.inventoryReleased === true && options.allowAvailableStockAfterReservationRelease !== true) {
        throw new Error('RESERVATION_EXPIRED');
      }
      // Solo el endpoint administrativo de revisión puede consumir stock disponible
      // después de que la reserva original haya sido liberada. La transacción vuelve
      // a comprobar cantidad disponible y evita descontar dos veces.
      await completeInventorySale(
        transaction,
        data.order.items,
        data.inventoryReleased === true ? false : true
      );
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
      if (validationIncident.exists) transaction.delete(validationIncidentRef);
      orderCreated = true;
    });
    if (orderCreated) notifyAdminsNewOrder(reference, pending.order);
    return { verified: true, alreadyRegistered: false };
  } catch (registrationError) {
    // El pago ya fue validado directamente con Mercado Pago. Si la reserva venció
    // y otro cliente consumió el stock, registrar una incidencia durable en vez
    // de dejar el webhook reintentando sin que administración pueda verla.
    if (!String(registrationError.message || '').startsWith('STOCK_INSUFFICIENT:')
      && registrationError.message !== 'RESERVATION_EXPIRED') {
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
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      transaction.update(pendingRef, {
        paymentApprovedNeedsReview: true,
        paymentApprovedAt: FieldValue.serverTimestamp(),
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
  if (!mpClient || !mpToken) {
    return res.status(503).json({ success: false, error: 'Mercado Pago no está configurado; no se liberaron reservas.' });
  }
  try {
    const now = Timestamp.now();
    const pendingCollection = firestore.collection('pagos_pendientes');
    const pageSize = 100;
    const maxPages = 10;
    let cursor = null;
    let released = 0;
    let failed = 0;
    let checked = 0;
    let truncated = false;

    // Paginar dentro de una ejecución evita que 100 documentos dañados al inicio
    // bloqueen indefinidamente la liberación de reservas vencidas posteriores.
    for (let page = 0; page < maxPages; page += 1) {
      let query = pendingCollection
        .where('expiresAt', '<=', now)
        .orderBy('expiresAt')
        .limit(pageSize);
      if (cursor) query = query.startAfter(cursor);
      const expired = await query.get();
      if (expired.empty) break;

      checked += expired.size;
      for (const pendingDoc of expired.docs) {
        cursor = pendingDoc;
        if (pendingDoc.data().inventoryReleased === true) continue;
        try {
          // Incidencias de creación ambigua o pagos aprobados con datos inconsistentes
          // requieren revisión; no se liberan automáticamente ni se reintentan a ciegas.
          const pendingData = pendingDoc.data();
          if (pendingData.paymentApprovedNeedsReview === true) continue;
          // La expiración local no demuestra que Mercado Pago no haya aprobado
          // el pago. Consultar siempre la API antes de liberar unidades reservadas.
          const payments = await searchPaymentsByExternalReference({
            accessToken: mpToken,
            externalReference: pendingDoc.id
          });
          if (payments.length === 0) {
            const expiresAt = pendingDoc.data().expiresAt?.toDate
              ? pendingDoc.data().expiresAt.toDate().getTime()
              : new Date(pendingDoc.data().expiresAt).getTime();
            const indexingGraceMs = 30 * 60 * 1000;
            // Payment Search can lag. Keep stock for a grace period after the
            // preference expires before treating an empty result as definitive.
            if (!Number.isFinite(expiresAt) || Date.now() - expiresAt < indexingGraceMs) continue;
            if (await releasePendingInventory(pendingDoc.ref, { confirmedNotApproved: true })) released += 1;
            continue;
          }

          const verifiedPayments = await Promise.all(payments.map(async result => {
            if (!result.id) throw new Error('Mercado Pago devolvió un pago sin identificador.');
            return new Payment(mpClient).get({ id: String(result.id) });
          }));
          if (verifiedPayments.some(payment => String(payment.external_reference || '') !== pendingDoc.id)) {
            throw new Error('Mercado Pago devolvió un pago con referencia externa distinta.');
          }

          const approvedPayment = verifiedPayments.find(payment => payment.status === 'approved');
          if (approvedPayment) {
            const registration = await registerApprovedPayment(
              approvedPayment.id,
              pendingDoc.id,
              null,
              approvedPayment
            );
            if (!registration.verified && !registration.needsAdminReview) {
              throw new Error('No se pudo completar la revisión del pago aprobado; se conserva la reserva.');
            }
            continue;
          }

          // Solo estados terminales explícitos permiten liberar. Pendiente,
          // en proceso, devuelto, contracargo o cualquier estado desconocido
          // conservan la reserva para revisión o una nueva consulta.
          const allConfirmedNotApproved = verifiedPayments.every(payment =>
            ['cancelled', 'rejected'].includes(String(payment.status || ''))
          );
          if (allConfirmedNotApproved
            && await releasePendingInventory(pendingDoc.ref, { confirmedNotApproved: true })) {
            released += 1;
          }
        } catch (cleanupError) {
          failed += 1;
          // Ante cualquier error de consulta, conservar stock y reportar la falla.
          console.error('No se pudo verificar/liberar una reserva vencida:', pendingDoc.id, cleanupError.message);
        }
      }
      if (expired.size < pageSize) break;

      // Si se agotó el presupuesto de páginas, comprobar si quedan documentos.
      // No informar éxito silencioso cuando todavía existe trabajo pendiente.
      if (page === maxPages - 1) {
        const remaining = await pendingCollection
          .where('expiresAt', '<=', now)
          .orderBy('expiresAt')
          .startAfter(cursor)
          .limit(1)
          .get();
        truncated = !remaining.empty;
      }
    }
    return res.json({
      success: failed === 0 && !truncated,
      released,
      failed,
      checked,
      maxPages,
      truncated
    });
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
      ...paymentIncidents.docs.map(doc => ({ id: doc.id, sourceCollection: 'incidencias_pagos', ...doc.data() })),
      ...checkoutIncidents.docs.map(doc => ({ id: doc.id, sourceCollection: 'incidencias_checkout', ...doc.data() }))
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

app.post('/api/admin/payment-incidents/:collection/:incidentId/retry-approved-payment', async (req, res) => {
  try {
    if (!requireServices(res)) return;
    const admin = await authenticatedAdmin(req);
    const collectionName = String(req.params.collection || '');
    const incidentId = String(req.params.incidentId || '');
    if (collectionName !== 'incidencias_pagos' || !/^[A-Za-z0-9_-]{1,180}$/.test(incidentId)) {
      return res.status(400).json({ success: false, error: 'Esta incidencia no admite reintento automático.' });
    }

    const incidentRef = firestore.collection(collectionName).doc(incidentId);
    const incidentSnap = await incidentRef.get();
    if (!incidentSnap.exists) return res.status(404).json({ success: false, error: 'La incidencia ya no existe.' });
    const incident = incidentSnap.data();
    if (incident.status === 'resolved') {
      return res.json({ success: true, alreadyResolved: true, message: 'La incidencia ya estaba resuelta.' });
    }
    if (incident.type !== 'approved_payment_stock_unavailable'
      || incident.paymentStatus !== 'approved'
      || !/^\d{1,30}$/.test(String(incident.paymentId || ''))
      || !/^[0-9a-f-]{36}$/i.test(String(incident.externalReference || ''))) {
      return res.status(409).json({ success: false, error: 'Solo se pueden reintentar pagos aprobados cuya única incidencia sea la falta de stock.' });
    }

    // Vuelve a consultar y validar el pago en Mercado Pago. Si la reserva original
    // ya venció, solo consume stock NO reservado y únicamente si sigue disponible.
    const result = await registerApprovedPayment(
      String(incident.paymentId),
      String(incident.externalReference),
      null,
      null,
      { allowAvailableStockAfterReservationRelease: true }
    );
    if (!result.verified || result.needsAdminReview) {
      return res.status(409).json({
        success: false,
        needsAdminReview: Boolean(result.needsAdminReview),
        error: result.needsAdminReview
          ? 'El pago sigue aprobado, pero el inventario todavía no permite completar el pedido. La incidencia continúa abierta.'
          : 'No se pudo validar el pago nuevamente con Mercado Pago. La incidencia continúa abierta.'
      });
    }

    await firestore.runTransaction(async transaction => {
      const freshIncident = await transaction.get(incidentRef);
      if (!freshIncident.exists) throw new Error('INCIDENT_NOT_FOUND');
      const fresh = freshIncident.data();
      if (String(fresh.paymentId || '') !== String(incident.paymentId)
        || String(fresh.externalReference || '') !== String(incident.externalReference)) {
        throw new Error('INCIDENT_CHANGED');
      }
      if (fresh.status !== 'resolved') {
        transaction.update(incidentRef, {
          status: 'resolved',
          resolution: 'approved_payment_registered_after_stock_review',
          adminResolvedAt: FieldValue.serverTimestamp(),
          adminResolvedBy: admin.email,
          updatedAt: FieldValue.serverTimestamp()
        });
      }
    });
    return res.json({
      success: true,
      alreadyRegistered: Boolean(result.alreadyRegistered),
      message: result.alreadyRegistered
        ? 'El pedido ya estaba registrado y la incidencia quedó resuelta.'
        : 'Pago verificado nuevamente y pedido registrado correctamente.'
    });
  } catch (error) {
    if (error.message === 'INCIDENT_NOT_FOUND') return res.status(404).json({ success: false, error: 'La incidencia ya no existe.' });
    if (error.message === 'INCIDENT_CHANGED') return res.status(409).json({ success: false, error: 'La incidencia cambió durante la operación. Actualizá el panel.' });
    const authError = ['AUTH_REQUIRED', 'AUTH_EMAIL_REQUIRED'].includes(error.message) || String(error.code || '').startsWith('auth/');
    const adminError = error.message === 'ADMIN_REQUIRED';
    console.error('Error reintentando pago aprobado:', error.message);
    return res.status(authError ? 401 : adminError ? 403 : 500).json({
      success: false,
      error: authError ? 'La sesión expiró. Volvé a iniciar sesión.'
        : adminError ? 'No tenés permisos para resolver incidencias.'
        : 'No se pudo reintentar el registro del pago.'
    });
  }
});

app.post('/api/admin/payment-incidents/:collection/:incidentId/review-note', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    const admin = await authenticatedAdmin(req);
    const collectionName = String(req.params.collection || '');
    const incidentId = String(req.params.incidentId || '');
    const note = String(req.body?.note || '').trim();
    if (!['incidencias_pagos', 'incidencias_checkout'].includes(collectionName)
      || !/^[A-Za-z0-9_-]{1,180}$/.test(incidentId)) {
      return res.status(400).json({ success: false, error: 'La incidencia indicada no es válida.' });
    }
    if (note.length < 5 || note.length > 1000) {
      return res.status(400).json({ success: false, error: 'La nota debe tener entre 5 y 1000 caracteres.' });
    }
    const incidentRef = firestore.collection(collectionName).doc(incidentId);
    await firestore.runTransaction(async transaction => {
      const incidentSnap = await transaction.get(incidentRef);
      if (!incidentSnap.exists) throw new Error('INCIDENT_NOT_FOUND');
      transaction.update(incidentRef, {
        adminReviewNote: note,
        adminReviewedAt: FieldValue.serverTimestamp(),
        adminReviewedBy: admin.email,
        updatedAt: FieldValue.serverTimestamp()
      });
    });
    return res.json({ success: true, incident_id: incidentId, reviewed: true });
  } catch (error) {
    if (error.message === 'INCIDENT_NOT_FOUND') return res.status(404).json({ success: false, error: 'La incidencia ya no existe.' });
    const authError = ['AUTH_REQUIRED', 'AUTH_EMAIL_REQUIRED'].includes(error.message) || String(error.code || '').startsWith('auth/');
    const adminError = error.message === 'ADMIN_REQUIRED';
    console.error('Error registrando revisión de incidencia:', error.message);
    return res.status(authError ? 401 : adminError ? 403 : 500).json({
      success: false,
      error: authError ? 'La sesión expiró. Volvé a iniciar sesión.'
        : adminError ? 'No tenés permisos para revisar incidencias.'
        : 'No se pudo guardar la nota de revisión.'
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

app.post('/api/admin/push-test', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    const adminUser = await authenticatedAdmin(req);
    if (!firebaseMessaging) {
      return res.status(503).json({ success: false, error: 'Firebase Cloud Messaging no está disponible.' });
    }
    const result = await sendAdminOrderPushNotifications({
      firestore,
      messaging: firebaseMessaging,
      orderId: 'push-test',
      order: { pushTest: true },
      onlyEmail: adminUser.email
    });
    return res.json({ success: true, ...result, message: 'Prueba de notificación enviada.' });
  } catch (error) {
    if (error.message === 'ADMIN_REQUIRED') return res.status(403).json({ success: false, error: 'No tenés permisos para probar las alertas.' });
    if (error.message === 'AUTH_REQUIRED' || error.message === 'AUTH_EMAIL_REQUIRED') return res.status(401).json({ success: false, error: 'La sesión expiró. Volvé a iniciar sesión.' });
    console.error('Error enviando prueba de notificaciones:', error.message);
    return res.status(503).json({ success: false, error: 'No se pudo enviar la prueba de notificaciones.' });
  }
});

app.post('/api/admin/push-token', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    const adminUser = await authenticatedAdmin(req);
    const token = String(req.body?.token || '');
    const tokenId = await registerAdminPushToken({ firestore, email: adminUser.email, token });
    return res.json({ success: true, tokenId });
  } catch (error) {
    if (error.message === 'ADMIN_REQUIRED') return res.status(403).json({ success: false, error: 'No tenés permisos para activar alertas.' });
    if (error.message === 'AUTH_REQUIRED' || error.message === 'AUTH_EMAIL_REQUIRED') return res.status(401).json({ success: false, error: 'La sesión expiró. Volvé a iniciar sesión.' });
    return res.status(400).json({ success: false, error: error.message || 'No se pudo registrar el dispositivo.' });
  }
});

app.delete('/api/admin/push-token', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    const adminUser = await authenticatedAdmin(req);
    const token = String(req.body?.token || '');
    const removed = await removeAdminPushToken({ firestore, email: adminUser.email, token });
    return res.json({ success: true, removed });
  } catch (error) {
    if (error.message === 'ADMIN_REQUIRED') return res.status(403).json({ success: false, error: 'No tenés permisos para desactivar alertas.' });
    if (error.message === 'AUTH_REQUIRED' || error.message === 'AUTH_EMAIL_REQUIRED') return res.status(401).json({ success: false, error: 'La sesión expiró. Volvé a iniciar sesión.' });
    return res.status(400).json({ success: false, error: error.message || 'No se pudo desactivar el dispositivo.' });
  }
});

app.post('/api/admin/test-order', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    const adminUser = await authenticatedAdmin(req);
    const orderRef = firestore.collection('pedidos').doc();
    const createdAt = new Date().toISOString();
    const testOrder = {
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
    };
    await orderRef.create(testOrder);
    // El pedido ficticio también debe probar el envío push a los dispositivos admin.
    // La alerta es asíncrona y no convierte esta prueba en una venta ni en un cobro.
    notifyAdminsNewOrder(orderRef.id, testOrder);
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
      if (isTestOrder(order)) {
        if (!canTransitionTestOrderStatus(currentStatus, newStatus)) {
          throw new Error('INVALID_TEST_ORDER_TRANSITION');
        }
        if (currentStatus === newStatus) return;
        const stageTimestamp = new Date().toISOString();
        const testUpdate = {
          status: newStatus,
          testResolution: order.testResolution || (newStatus === 'rechazado' ? 'rejected' : 'accepted'),
          testStageUpdatedAt: stageTimestamp
        };
        if (currentStatus === 'nuevo') testUpdate.testResolvedAt = stageTimestamp;
        if (newStatus === 'finalizado') testUpdate.testCompletedAt = stageTimestamp;
        transaction.update(orderRef, testUpdate);
        return;
      }
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
        transaction.update(orderRef, {
          status: newStatus,
          ...(newStatus === 'finalizado' ? { completedAt: new Date().toISOString() } : {})
        });
      }
    });
    return res.json({ success: true, order_id: orderId, status: newStatus });
  } catch (error) {
    if (error.message === 'ORDER_NOT_FOUND') return res.status(404).json({ success: false, error: 'El pedido no existe.' });
    if (error.message === 'INVALID_TEST_ORDER_TRANSITION') return res.status(409).json({ success: false, error: 'La prueba ya fue resuelta o el estado solicitado no es válido.' });
    if (error.message === 'INVALID_STATUS_TRANSITION') return res.status(409).json({ success: false, error: 'Ese cambio de estado no está permitido. Los pedidos entregados o rechazados no se pueden reabrir ni rechazar nuevamente.' });
    if (error.message === 'PAYMENT_REFUND_REQUIRED') return res.status(409).json({ success: false, error: 'Este pedido fue cobrado con Mercado Pago. Primero realizá la devolución desde Mercado Pago y esperá que el pedido muestre DEVUELTO; recién entonces podrás rechazarlo y devolver el stock. Si figura CONTRACARGO, requiere revisión manual.' });
    if (error.message === 'ADMIN_REQUIRED') return res.status(403).json({ success: false, error: 'No tenés permisos para modificar pedidos.' });
    if (error.message === 'AUTH_REQUIRED' || error.message === 'AUTH_EMAIL_REQUIRED') return res.status(401).json({ success: false, error: 'La sesión expiró. Volvé a iniciar sesión.' });
    console.error('Error actualizando estado del pedido:', error.message);
    return res.status(500).json({ success: false, error: 'No se pudo actualizar el pedido.' });
  }
});



app.get('/api/admin/couriers', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    await authenticatedAdmin(req);
    const [snapshot, ordersSnapshot] = await Promise.all([
      firestore.collection('repartidores').get(),
      firestore.collection('pedidos').get()
    ]);
    const activeDeliveryCounts = new Map();
    ordersSnapshot.docs.forEach(orderDoc => {
      const delivery = orderDoc.data().delivery || {};
      if (['assigned', 'en_camino'].includes(String(delivery.status || '')) && delivery.courierId) {
        activeDeliveryCounts.set(String(delivery.courierId), (activeDeliveryCounts.get(String(delivery.courierId)) || 0) + 1);
      }
    });
    const couriers = snapshot.docs.map(doc => {
      const data = doc.data();
      const activeDeliveryCount = activeDeliveryCounts.get(doc.id) || 0;
      return {
        id: doc.id,
        ...data,
        activeDeliveryCount,
        availability: data.active === false ? 'inactive' : activeDeliveryCount > 0 ? 'busy' : 'available'
      };
    }).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'es'));
    return res.json({ success: true, couriers });
  } catch (error) {
    if (error.message === 'ADMIN_REQUIRED') return res.status(403).json({ success: false, error: 'No tenés permisos para consultar repartidores.' });
    if (error.message === 'AUTH_REQUIRED' || error.message === 'AUTH_EMAIL_REQUIRED') return res.status(401).json({ success: false, error: 'La sesión expiró. Volvé a iniciar sesión.' });
    console.error('Error consultando repartidores:', error.message);
    return res.status(500).json({ success: false, error: 'No se pudieron cargar los repartidores.' });
  }
});

app.post('/api/admin/couriers', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    const admin = await authenticatedAdmin(req);
    const courier = normalizeCourier(req.body || {});
    const id = courierDocumentId(courier.email);
    const ref = firestore.collection('repartidores').doc(id);
    const previous = await ref.get();
    const active = req.body?.active === false ? false : true;
    await ref.set({
      ...courier,
      active,
      createdAt: previous.exists ? previous.data().createdAt || FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: String(admin.email).toLowerCase()
    }, { merge: true });
    return res.status(previous.exists ? 200 : 201).json({ success: true, courier: { id, ...courier, active } });
  } catch (error) {
    if (error.message === 'COURIER_EMAIL_INVALID' || error.message === 'COURIER_NAME_INVALID'
      || error.message === 'COURIER_PHONE_INVALID' || error.message === 'COURIER_WHATSAPP_INVALID') {
      return res.status(400).json({ success: false, error: 'Revisá nombre, correo, teléfono y WhatsApp internacional del repartidor.' });
    }
    if (error.message === 'ADMIN_REQUIRED') return res.status(403).json({ success: false, error: 'No tenés permisos para administrar repartidores.' });
    if (error.message === 'AUTH_REQUIRED' || error.message === 'AUTH_EMAIL_REQUIRED') return res.status(401).json({ success: false, error: 'La sesión expiró. Volvé a iniciar sesión.' });
    console.error('Error guardando repartidor:', error.message);
    return res.status(500).json({ success: false, error: 'No se pudo guardar el repartidor.' });
  }
});

app.post('/api/admin/orders/:orderId/assign-courier', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    const admin = await authenticatedAdmin(req);
    const orderId = String(req.params.orderId || '');
    const courierId = String(req.body?.courierId || '');
    if (!/^[A-Za-z0-9_-]{1,150}$/.test(orderId) || !/^[a-f0-9]{64}$/.test(courierId)) {
      return res.status(400).json({ success: false, error: 'Pedido o repartidor inválido.' });
    }
    const orderRef = firestore.collection('pedidos').doc(orderId);
    const courierRef = firestore.collection('repartidores').doc(courierId);
    const result = await firestore.runTransaction(async transaction => {
      const [orderSnap, courierSnap] = await Promise.all([
        transaction.get(orderRef), transaction.get(courierRef)
      ]);
      if (!orderSnap.exists) throw new Error('ORDER_NOT_FOUND');
      if (!courierSnap.exists || courierSnap.data().active === false) throw new Error('COURIER_NOT_AVAILABLE');
      const order = orderSnap.data();
      if (isTestOrder(order)) throw new Error('TEST_ORDER');
      if (String(order.status || '') !== 'listo') throw new Error('ORDER_NOT_READY');
      if (order.delivery?.status === 'delivered') throw new Error('DELIVERY_COMPLETED');
      if (['assigned', 'en_camino'].includes(String(order.delivery?.status || ''))
        && req.body?.confirmReassignment !== true) {
        throw new Error('REASSIGNMENT_CONFIRMATION_REQUIRED');
      }
      const courier = courierSnap.data();
      const delivery = {
        courierId,
        courierName: courier.name,
        status: 'assigned',
        assignedAt: FieldValue.serverTimestamp(),
        assignedBy: String(admin.email).toLowerCase()
      };
      transaction.update(orderRef, { delivery });
      return { order, courier, delivery };
    });
    const whatsappUrl = buildCourierWhatsAppUrl(result.courier, orderId, result.order);
    return res.json({
      success: true,
      orderId,
      deliveryStatus: 'assigned',
      courier: { id: courierId, name: result.courier.name, phone: result.courier.phone },
      whatsappUrl
    });
  } catch (error) {
    if (error.message === 'ORDER_NOT_FOUND') return res.status(404).json({ success: false, error: 'El pedido no existe.' });
    if (error.message === 'COURIER_NOT_AVAILABLE') return res.status(409).json({ success: false, error: 'El repartidor no existe o está inactivo.' });
    if (error.message === 'TEST_ORDER') return res.status(409).json({ success: false, error: 'Los pedidos de prueba no se pueden asignar.' });
    if (error.message === 'ORDER_NOT_READY') return res.status(409).json({ success: false, error: 'El pedido debe estar marcado como listo antes de asignarlo.' });
    if (error.message === 'DELIVERY_COMPLETED') return res.status(409).json({ success: false, error: 'La entrega ya fue completada.' });
     if (error.message === 'REASSIGNMENT_CONFIRMATION_REQUIRED') return res.status(409).json({ success: false, error: 'El pedido ya está asignado. Confirmá la reasignación antes de cambiar de repartidor.' });
    if (error.message === 'ADMIN_REQUIRED') return res.status(403).json({ success: false, error: 'No tenés permisos para asignar pedidos.' });
    if (error.message === 'AUTH_REQUIRED' || error.message === 'AUTH_EMAIL_REQUIRED') return res.status(401).json({ success: false, error: 'La sesión expiró. Volvé a iniciar sesión.' });
    console.error('Error asignando repartidor:', error.message);
    return res.status(500).json({ success: false, error: 'No se pudo asignar el repartidor.' });
  }
});


app.post('/api/admin/assign-courier-batch', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    const admin = await authenticatedAdmin(req);
    const courierId = String(req.body?.courierId || '');
    const orderIds = Array.isArray(req.body?.orderIds)
      ? [...new Set(req.body.orderIds.map(value => String(value || '')))]
      : [];
    if (!/^[a-f0-9]{64}$/.test(courierId)
      || orderIds.length < 1 || orderIds.length > 25
      || orderIds.some(id => !/^[A-Za-z0-9_-]{1,150}$/.test(id))) {
      return res.status(400).json({ success: false, error: 'Seleccioná entre 1 y 25 pedidos válidos y un repartidor.' });
    }
    const courierRef = firestore.collection('repartidores').doc(courierId);
    const orderRefs = orderIds.map(id => firestore.collection('pedidos').doc(id));
    const result = await firestore.runTransaction(async transaction => {
      const [courierSnap, ...orderSnaps] = await Promise.all([
        transaction.get(courierRef), ...orderRefs.map(ref => transaction.get(ref))
      ]);
      if (!courierSnap.exists || courierSnap.data().active === false) throw new Error('COURIER_NOT_AVAILABLE');
      const courier = courierSnap.data();
      const candidates = orderSnaps.map((snap, index) => {
        if (!snap.exists) throw new Error('ORDER_NOT_FOUND');
        const order = snap.data();
        if (isTestOrder(order)) throw new Error('TEST_ORDER');
        if (String(order.status || '') !== 'listo') throw new Error('ORDER_NOT_READY');
        if (order.delivery?.status === 'delivered') throw new Error('DELIVERY_COMPLETED');
        if (['assigned', 'en_camino'].includes(String(order.delivery?.status || ''))) {
          throw new Error('ORDER_ALREADY_ASSIGNED');
        }
        return { orderId: orderIds[index], ...order };
      });
      const optimized = optimizeDeliveryStops(candidates);
      const batchId = crypto.randomUUID();
      const assignments = optimized.map((order, index) => ({
        ...order,
        routeOrder: index + 1
      }));
      assignments.forEach(order => {
        const delivery = {
          courierId,
          courierName: courier.name,
          status: 'assigned',
          routeOrder: order.routeOrder,
          batchId,
          assignedAt: FieldValue.serverTimestamp(),
          assignedBy: String(admin.email).toLowerCase()
        };
        transaction.update(firestore.collection('pedidos').doc(order.orderId), { delivery });
      });
      return { courier, assignments };
    });
    const routeSegments = buildGoogleMapsRouteSegments(result.assignments);
    const routeUrl = routeSegments.map(segment => 'Paradas ' + segment.firstStop + ' a ' + segment.lastStop + ': ' + segment.url).join('\n');
    const whatsappOrders = result.assignments.map(order => ({
      orderId: order.orderId,
      clientName: order.clientName,
      clientPhone: order.clientPhone,
      address: order.address
    }));
    const whatsappUrl = buildBatchCourierWhatsAppUrl(result.courier, whatsappOrders, routeUrl);
    return res.json({
      success: true,
      courier: { id: courierId, name: result.courier.name },
      assignedOrderIds: result.assignments.map(order => order.orderId),
      route: result.assignments.map(order => ({
        orderId: order.orderId,
        routeOrder: order.routeOrder,
        address: order.address,
        deliveryLocation: order.deliveryLocation || null
      })),
      routeUrl: routeSegments[0]?.url || null,
      routeSegments,
      whatsappUrl
    });
  } catch (error) {
    if (error.message === 'COURIER_NOT_AVAILABLE') return res.status(409).json({ success: false, error: 'El repartidor no existe o está inactivo.' });
    if (error.message === 'ORDER_NOT_FOUND') return res.status(404).json({ success: false, error: 'Uno de los pedidos seleccionados ya no existe.' });
    if (error.message === 'TEST_ORDER') return res.status(409).json({ success: false, error: 'Los pedidos de prueba no se pueden asignar.' });
    if (error.message === 'ORDER_NOT_READY') return res.status(409).json({ success: false, error: 'Todos los pedidos deben estar marcados como listos antes de asignarlos.' });
    if (error.message === 'DELIVERY_COMPLETED') return res.status(409).json({ success: false, error: 'Uno de los pedidos ya fue entregado.' });
     if (error.message === 'ORDER_ALREADY_ASSIGNED') return res.status(409).json({ success: false, error: 'Uno o más pedidos ya están asignados. Usá la opción de reasignar individualmente para cambiar su responsable.' });
    if (error.message === 'ADMIN_REQUIRED') return res.status(403).json({ success: false, error: 'No tenés permisos para asignar pedidos.' });
    if (error.message === 'AUTH_REQUIRED' || error.message === 'AUTH_EMAIL_REQUIRED') return res.status(401).json({ success: false, error: 'La sesión expiró. Volvé a iniciar sesión.' });
    console.error('Error asignando lote de reparto:', error.message);
    return res.status(500).json({ success: false, error: 'No se pudo asignar el recorrido.' });
  }
});

app.get('/api/courier/orders', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    const user = await authenticatedUser(req);
    const id = courierDocumentId(user.email);
    const courierSnap = await firestore.collection('repartidores').doc(id).get();
    if (!courierSnap.exists || courierSnap.data().active === false
      || String(courierSnap.data().email || '').toLowerCase() !== String(user.email).toLowerCase()) {
      return res.status(403).json({ success: false, error: 'Esta cuenta no está habilitada como repartidor.' });
    }
    const snapshot = await firestore.collection('pedidos')
      .where('delivery.courierId', '==', id).get();
    const allAssignedOrders = snapshot.docs.map(doc => buildCourierOrder(doc.id, doc.data(), doc.data().delivery || {}));
    const orders = allAssignedOrders
      .filter(order => ['assigned', 'en_camino'].includes(order.status))
      .sort((a, b) => Number(a.routeOrder || 9999) - Number(b.routeOrder || 9999));
    const completedCount = allAssignedOrders.filter(order => order.status === 'delivered').length;
    const routeSegments = buildGoogleMapsRouteSegments(orders);
    return res.json({ success: true, courier: { name: courierSnap.data().name }, orders, completedCount, routeSegments });
  } catch (error) {
    if (error.message === 'COURIER_EMAIL_INVALID') return res.status(403).json({ success: false, error: 'Esta cuenta no está habilitada como repartidor.' });
    if (error.message === 'AUTH_REQUIRED' || error.message === 'AUTH_EMAIL_REQUIRED') return res.status(401).json({ success: false, error: 'Iniciá sesión para consultar tus entregas.' });
    console.error('Error consultando entregas del repartidor:', error.message);
    return res.status(500).json({ success: false, error: 'No se pudieron cargar tus entregas.' });
  }
});


app.post('/api/courier/route/optimize', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    const user = await authenticatedUser(req);
    const courierId = courierDocumentId(user.email);
    const lat = Number(req.body?.origin?.lat);
    const lon = Number(req.body?.origin?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return res.status(400).json({ success: false, error: 'No se recibió una ubicación válida.' });
    }
    const courierRef = firestore.collection('repartidores').doc(courierId);
    const [courierSnap, assignedSnapshot] = await Promise.all([
      courierRef.get(),
      firestore.collection('pedidos').where('delivery.courierId', '==', courierId).get()
    ]);
    if (!courierSnap.exists || courierSnap.data().active === false
      || String(courierSnap.data().email || '').toLowerCase() !== String(user.email).toLowerCase()) {
      return res.status(403).json({ success: false, error: 'Esta cuenta no está habilitada como repartidor.' });
    }
    const activeDocs = assignedSnapshot.docs.filter(doc =>
      ['assigned', 'en_camino'].includes(String(doc.data().delivery?.status || '')));
    if (!activeDocs.length) return res.json({ success: true, routeSegments: [], stopCount: 0 });
    if (activeDocs.length > 50) return res.status(409).json({ success: false, error: 'Hay más de 50 entregas activas. Dividí el recorrido en dos tandas.' });
    const refs = activeDocs.map(doc => doc.ref);
    const optimized = optimizeDeliveryStops(activeDocs.map(doc => ({
      orderId: doc.id,
      ...doc.data(),
      deliveryLocation: doc.data().deliveryLocation || null
    })), { lat, lon });
    await firestore.runTransaction(async transaction => {
      const fresh = await Promise.all(refs.map(ref => transaction.get(ref)));
      fresh.forEach((snap, index) => {
        if (!snap.exists || snap.data().delivery?.courierId !== courierId
          || !['assigned', 'en_camino'].includes(String(snap.data().delivery?.status || ''))) {
          throw new Error('ROUTE_CHANGED');
        }
      });
      optimized.forEach(order => {
        transaction.update(firestore.collection('pedidos').doc(order.orderId), {
          'delivery.routeOrder': order.routeOrder,
          'delivery.routeOptimizedAt': FieldValue.serverTimestamp()
        });
      });
    });
    const routeSegments = buildGoogleMapsRouteSegments(optimized);
    return res.json({ success: true, stopCount: optimized.length, routeSegments });
  } catch (error) {
    if (error.message === 'ROUTE_CHANGED') return res.status(409).json({ success: false, error: 'Tus pedidos cambiaron. Actualizá la lista e intentá nuevamente.' });
    if (error.message === 'COURIER_EMAIL_INVALID') return res.status(403).json({ success: false, error: 'Esta cuenta no está habilitada como repartidor.' });
    if (error.message === 'AUTH_REQUIRED' || error.message === 'AUTH_EMAIL_REQUIRED') return res.status(401).json({ success: false, error: 'La sesión expiró. Volvé a iniciar sesión.' });
    console.error('Error optimizando recorrido:', error.message);
    return res.status(500).json({ success: false, error: 'No se pudo optimizar el recorrido.' });
  }
});

app.post('/api/courier/orders/:orderId/status', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    const user = await authenticatedUser(req);
    const courierId = courierDocumentId(user.email);
    const nextStatus = String(req.body?.status || '');
    const orderId = String(req.params.orderId || '');
    if (!/^[A-Za-z0-9_-]{1,150}$/.test(orderId) || !['en_camino', 'delivered'].includes(nextStatus)) {
      return res.status(400).json({ success: false, error: 'Pedido o estado de entrega inválido.' });
    }
    const courierSnap = await firestore.collection('repartidores').doc(courierId).get();
    if (!courierSnap.exists || courierSnap.data().active === false
      || String(courierSnap.data().email || '').toLowerCase() !== String(user.email).toLowerCase()) {
      return res.status(403).json({ success: false, error: 'Esta cuenta no está habilitada como repartidor.' });
    }
    const orderRef = firestore.collection('pedidos').doc(orderId);
    await firestore.runTransaction(async transaction => {
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists) throw new Error('ORDER_NOT_FOUND');
      const order = orderSnap.data();
      const delivery = order.delivery || {};
      if (delivery.courierId !== courierId) throw new Error('COURIER_NOT_ASSIGNED');
      if (!canTransitionDeliveryStatus(String(delivery.status || ''), nextStatus)) throw new Error('INVALID_DELIVERY_TRANSITION');
      if (delivery.status === nextStatus) return;
      const update = {
        'delivery.status': nextStatus,
        ...(nextStatus === 'en_camino' ? { 'delivery.pickedUpAt': FieldValue.serverTimestamp() } : {
          'delivery.deliveredAt': FieldValue.serverTimestamp(),
          status: 'finalizado',
          completedAt: new Date().toISOString()
        })
      };
      transaction.update(orderRef, update);
    });
    return res.json({ success: true, orderId, deliveryStatus: nextStatus });
  } catch (error) {
    if (error.message === 'ORDER_NOT_FOUND') return res.status(404).json({ success: false, error: 'El pedido no existe.' });
    if (error.message === 'COURIER_NOT_ASSIGNED') return res.status(403).json({ success: false, error: 'Este pedido no está asignado a tu cuenta.' });
    if (error.message === 'INVALID_DELIVERY_TRANSITION') return res.status(409).json({ success: false, error: 'Primero marcá el pedido en camino y luego como entregado.' });
    if (error.message === 'COURIER_EMAIL_INVALID') return res.status(403).json({ success: false, error: 'Esta cuenta no está habilitada como repartidor.' });
    if (error.message === 'AUTH_REQUIRED' || error.message === 'AUTH_EMAIL_REQUIRED') return res.status(401).json({ success: false, error: 'La sesión expiró. Volvé a iniciar sesión.' });
    console.error('Error actualizando entrega:', error.message);
    return res.status(500).json({ success: false, error: 'No se pudo actualizar la entrega.' });
  }
});

app.post('/api/admin/orders/:orderId/cash-payment', async (req, res) => {
  try {
    if (!requireFirebaseServices(res)) return;
    const admin = await authenticatedAdmin(req);
    const orderId = String(req.params.orderId || '');
    if (!/^[A-Za-z0-9_-]{1,150}$/.test(orderId)) {
      return res.status(400).json({ success: false, error: 'Pedido inválido.' });
    }
    const orderRef = firestore.collection('pedidos').doc(orderId);
    const result = await firestore.runTransaction(async transaction => {
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists) throw new Error('ORDER_NOT_FOUND');
      const order = orderSnap.data();
      if (isTestOrder(order)) throw new Error('TEST_ORDER');
      if (String(order.paymentMethod || 'efectivo').toLowerCase() !== 'efectivo') {
        throw new Error('CASH_PAYMENT_ONLY');
      }
      if (!['finalizado', 'entregado'].includes(String(order.status || ''))) {
        throw new Error('ORDER_NOT_COMPLETED');
      }
      if (order.paymentStatus === 'cash_received') return { alreadyReceived: true };
      if (order.paymentStatus !== 'pending') throw new Error('PAYMENT_NOT_PENDING');
      transaction.update(orderRef, {
        paymentStatus: 'cash_received',
        paymentReceivedAt: FieldValue.serverTimestamp(),
        paymentReceivedBy: String(admin.email).toLowerCase()
      });
      return { alreadyReceived: false };
    });
    return res.json({ success: true, order_id: orderId, paymentStatus: 'cash_received', alreadyReceived: result.alreadyReceived });
  } catch (error) {
    if (error.message === 'ORDER_NOT_FOUND') return res.status(404).json({ success: false, error: 'El pedido no existe.' });
    if (error.message === 'TEST_ORDER') return res.status(409).json({ success: false, error: 'Los pedidos de prueba no registran cobros.' });
    if (error.message === 'CASH_PAYMENT_ONLY') return res.status(409).json({ success: false, error: 'Solo se puede registrar el cobro de pedidos en efectivo.' });
    if (error.message === 'ORDER_NOT_COMPLETED') return res.status(409).json({ success: false, error: 'Primero debe finalizarse la entrega del pedido.' });
    if (error.message === 'PAYMENT_NOT_PENDING') return res.status(409).json({ success: false, error: 'El estado de pago ya cambió y requiere verificación.' });
    if (error.message === 'ADMIN_REQUIRED') return res.status(403).json({ success: false, error: 'No tenés permisos para registrar cobros.' });
    if (error.message === 'AUTH_REQUIRED' || error.message === 'AUTH_EMAIL_REQUIRED') return res.status(401).json({ success: false, error: 'La sesión expiró. Volvé a iniciar sesión.' });
    console.error('Error registrando cobro en efectivo:', error.message);
    return res.status(500).json({ success: false, error: 'No se pudo registrar el cobro en efectivo.' });
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
    await requireCustomerAccount(user, firestore);
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
    let deliveryLocation = null;
    if (order.deliveryLocation != null) {
      const { lat, lon } = order.deliveryLocation;
      if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        throw new Error('La ubicación del mapa no es válida. Volvé a seleccionar el punto de entrega.');
      }
      deliveryLocation = { lat, lon };
    }
    if (!clientName || !clientPhone || !address) {
      return res.status(400).json({ success: false, error: 'Completá nombre, teléfono y dirección.' });
    }
    const pricedItems = await priceCartItems(items);
    const total = money(pricedItems.reduce((sum, item) => sum + item.price * item.qty, 0));
    const orderData = { clientName, clientPhone, address, notes, ...(deliveryLocation ? { deliveryLocation } : {}), items: pricedItems, total };
    const idempotency = checkoutIdempotency(req, user, pricedItems, orderData, 'efectivo');
    const orderRef = firestore.collection('pedidos').doc();
    let finalOrderId = orderRef.id;
    let replayed = false;
    let orderCreated = false;
    await firestore.runTransaction(async transaction => {
      orderCreated = false;
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
      orderCreated = true;
      transaction.set(idempotency.ref, {
        uid: user.uid,
        paymentMethod: 'efectivo',
        requestHash: idempotency.requestHash,
        orderId: orderRef.id,
        status: 'completed',
        createdAt: FieldValue.serverTimestamp()
      });
    });
    if (orderCreated) notifyAdminsNewOrder(finalOrderId, orderData);
    return res.status(replayed ? 200 : 201).json({ success: true, order_id: finalOrderId, replayed });
  } catch (error) {
    const authError = ['AUTH_REQUIRED', 'AUTH_EMAIL_REQUIRED'].includes(error.message);
    if (error.message === 'ADMIN_CANNOT_PURCHASE') return res.status(403).json({ success: false, error: 'Las cuentas administradoras no pueden realizar compras.' });
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
    await requireCustomerAccount(user, firestore);
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
    let deliveryLocation = null;
    if (order.deliveryLocation != null) {
      const { lat, lon } = order.deliveryLocation;
      if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        throw new Error('La ubicación del mapa no es válida. Volvé a seleccionar el punto de entrega.');
      }
      deliveryLocation = { lat, lon };
    }
    if (!clientName || !clientPhone || !address) {
      return res.status(400).json({ success: false, error: 'Completá nombre, teléfono y dirección.' });
    }

    const pricedItems = await priceCartItems(items);
    const total = money(pricedItems.reduce((sum, item) => sum + item.price * item.qty, 0));
    const orderData = { clientName, clientPhone, address, notes, ...(deliveryLocation ? { deliveryLocation } : {}), items: pricedItems, total };
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
            const pendingRef = previous.externalReference
              ? firestore.collection('pagos_pendientes').doc(String(previous.externalReference))
              : null;
            const [incidentSnap, pendingSnap] = await Promise.all([
              transaction.get(incidentRef),
              pendingRef ? transaction.get(pendingRef) : Promise.resolve(null)
            ]);
            if (!incidentSnap.exists) {
              transaction.create(incidentRef, {
                type: 'mercadopago_preference_creation_interrupted',
                status: 'needs_admin_review',
                uid: user.uid,
                userEmail: user.email,
                externalReference: previous.externalReference || null,
                checkoutRequestId: idempotency.ref.id,
                createdAt: FieldValue.serverTimestamp(),
                description: 'El intento quedó en processing más de cinco minutos. Verificar en Mercado Pago si se creó una preferencia antes de liberar la reserva o reintentar.'
              });
            }
            if (pendingRef && pendingSnap?.exists) {
              transaction.update(pendingRef, {
                preferenceCreationNeedsReview: true,
                preferenceCreationFailedAt: FieldValue.serverTimestamp()
              });
            }
            transaction.update(idempotency.ref, {
              status: 'needs_review',
              needsReviewAt: FieldValue.serverTimestamp()
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
        expiresAt: Timestamp.fromDate(reservationEnd),
        createdAt: FieldValue.serverTimestamp()
      });
      transaction.set(idempotency.ref, {
        uid: user.uid,
        paymentMethod: 'mercadopago',
        requestHash: idempotency.requestHash,
        externalReference,
        status: 'processing',
        createdAt: FieldValue.serverTimestamp()
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
        preferenceCreatedAt: FieldValue.serverTimestamp()
      });
      await idempotency.ref.update({
        status: 'completed',
        initPoint: result.init_point,
        preferenceId: String(result.id),
        completedAt: FieldValue.serverTimestamp()
      });
      return res.json({ success: true, init_point: result.init_point, external_reference: externalReference, reservation_expires_at: reservationEnd.toISOString(), replayed: false });
    } catch (preferenceError) {
      // Un timeout o error de red no demuestra que Mercado Pago no haya creado
      // la preferencia. Conservar la reserva y bloquear reintentos ciegos evita
      // cobrar dos veces o vender las mismas unidades a otro cliente.
      try {
        const incidentRef = firestore.collection('incidencias_checkout').doc(idempotency.ref.id);
        await firestore.runTransaction(async transaction => {
          const [freshPending, existingIncident] = await Promise.all([
            transaction.get(pendingRef),
            transaction.get(incidentRef)
          ]);
          if (freshPending.exists) {
            transaction.update(pendingRef, {
              preferenceCreationNeedsReview: true,
              preferenceCreationError: String(preferenceError.message || 'Error desconocido').slice(0, 500),
              preferenceCreationFailedAt: FieldValue.serverTimestamp()
            });
          }
          if (!existingIncident.exists) {
            transaction.create(incidentRef, {
              type: 'mercadopago_preference_creation_ambiguous',
              status: 'needs_admin_review',
              uid: user.uid,
              userEmail: user.email,
              externalReference,
              checkoutRequestId: idempotency.ref.id,
              total,
              currency: 'ARS',
              stockReservationExpiresAt: reservationEnd.toISOString(),
              error: String(preferenceError.message || 'Error desconocido').slice(0, 500),
              createdAt: FieldValue.serverTimestamp()
            });
          }
          transaction.set(idempotency.ref, {
            status: 'needs_review',
            needsReviewAt: FieldValue.serverTimestamp()
          }, { merge: true });
        });
      } catch (reviewError) {
        // Si Firestore tampoco responde, dejar el estado processing. El control
        // de intentos antiguos lo convertirá en revisión sin liberar stock.
        console.error('No se pudo registrar la incidencia del checkout:', reviewError.message);
      }
      return res.status(409).json({
        success: false,
        code: 'CHECKOUT_NEEDS_REVIEW',
        error: 'No pudimos confirmar si Mercado Pago creó el intento. No vuelvas a pagar ni generes otro pedido hasta que administración lo revise.'
      });
    }
  } catch (error) {
    const authError = ['AUTH_REQUIRED', 'AUTH_EMAIL_REQUIRED'].includes(error.message);
    if (error.message === 'ADMIN_CANNOT_PURCHASE') return res.status(403).json({ success: false, error: 'Las cuentas administradoras no pueden realizar compras.' });
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
      paymentStatusUpdatedAt: FieldValue.serverTimestamp()
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
      if (['cancelled', 'rejected'].includes(paymentStatus)) {
        // Mercado Pago confirmó que este intento no fue aprobado: ya es seguro
        // liberar una reserva retenida por la creación ambigua de la preferencia.
        await releasePendingInventory(
          firestore.collection('pagos_pendientes').doc(reference),
          { confirmedNotApproved: true }
        );
      }
      // Una devolución o contracargo posterior a la aprobación debe reflejarse
      // en el pedido existente. No se repone stock automáticamente: el producto
      // puede haber sido preparado o entregado y requiere decisión administrativa.
      if (['refunded', 'charged_back'].includes(paymentStatus)) {
        await updateReversedPayment(paymentId, reference, paymentStatus);
      }
      return res.sendStatus(200);
    }
    const result = await registerApprovedPayment(paymentId, reference, null, payment);
    if (result.needsAdminReview) return res.sendStatus(200);
    if (!result.verified) return res.status(500).json({ received: true, processed: false });
    return res.sendStatus(200);
  } catch (error) {
    console.error('Error procesando webhook:', error.message);
    return res.sendStatus(500);
  }
});


// Las rutas inexistentes de la API también responden JSON consistente.
app.use((_req, res) => {
  return res.status(404).json({ success: false, error: 'La ruta solicitada no existe.' });
});

// Normaliza errores de infraestructura antes de responder al cliente.
// Evita respuestas HTML genéricas y no expone detalles internos del servidor.
app.use((error, _req, res, _next) => {
  if (res.headersSent) return;

  if (error.message === 'Origen no autorizado por CORS') {
    return res.status(403).json({ success: false, error: 'Origen no autorizado.' });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'La solicitud supera el tamaño permitido.' });
  }
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'El cuerpo JSON de la solicitud no es válido.' });
  }

  console.error('Error HTTP no controlado:', error.message);
  return res.status(500).json({ success: false, error: 'Error interno del servidor.' });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
  });
}

module.exports = app;
