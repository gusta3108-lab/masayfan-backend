const express = require('express');
const crypto = require('node:crypto');
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
  allowedHeaders: ['Content-Type', 'Authorization']
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
  const decoded = await firebaseAuth.verifyIdToken(header.slice(7), true);
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
    } else {
      if (!itemId || itemId.startsWith('banner_')) throw new Error('No se pudo identificar un producto del carrito.');
      const productSnap = await firestore.collection('productos').doc(itemId).get();
      if (!productSnap.exists) throw new Error('Uno de los productos ya no existe.');
      const product = productSnap.data();
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
    transaction.set(orderRef, {
      ...data.order,
      userEmail: data.userEmail,
      uid: data.uid,
      status: 'nuevo',
      paymentMethod: 'mercadopago',
      paymentId: String(paymentId),
      paymentStatus: 'approved',
      createdAt: new Date().toISOString()
    });
    transaction.delete(pendingRef);
  });

  return { verified: true, alreadyRegistered: false };
}

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
    const authError = ['AUTH_REQUIRED', 'AUTH_EMAIL_REQUIRED'].includes(error.message);
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
    const orderRef = firestore.collection('pedidos').doc();
    await orderRef.create({
      clientName, clientPhone, address, notes,
      items: pricedItems,
      total,
      uid: user.uid,
      userEmail: user.email,
      status: 'nuevo',
      paymentMethod: 'efectivo',
      paymentStatus: 'pending',
      createdAt: new Date().toISOString()
    });
    return res.status(201).json({ success: true, order_id: orderRef.id });
  } catch (error) {
    const authError = ['AUTH_REQUIRED', 'AUTH_EMAIL_REQUIRED'].includes(error.message);
    console.error('Error registrando pedido en efectivo:', error.message);
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
    const externalReference = crypto.randomUUID();

    const preference = new Preference(mpClient);
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
        back_urls: {
          success: 'https://masayfantasias.com/?mp_return=1',
          failure: 'https://masayfantasias.com/?mp_return=1',
          pending: 'https://masayfantasias.com/?mp_return=1'
        },
        notification_url: 'https://masayfantasias-webhook-2026.onrender.com/api/webhook',
        auto_return: 'approved'
      }
    });

    const orderData = {
      clientName, clientPhone, address, notes,
      items: pricedItems,
      total
    };
    await firestore.collection('pagos_pendientes').doc(externalReference).create({
      uid: user.uid,
      userEmail: user.email,
      total,
      preferenceId: String(result.id),
      order: orderData,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, init_point: result.init_point, external_reference: externalReference });
  } catch (error) {
    const authError = ['AUTH_REQUIRED', 'AUTH_EMAIL_REQUIRED'].includes(error.message);
    console.error('Error creando preferencia:', error.message);
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
    if (payment.status !== 'approved') return res.sendStatus(200);
    const reference = String(payment.external_reference || '');
    if (!reference) return res.sendStatus(200);
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
