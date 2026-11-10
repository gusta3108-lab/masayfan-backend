const express = require('express');
const cors = require('cors');
const crypto = require('node:crypto');
const admin = require('firebase-admin');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

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
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firestore = admin.firestore();
    firebaseAuth = admin.auth();
  }
} catch (error) {
  console.error('No se pudo inicializar Firebase Admin. Revisá FIREBASE_SERVICE_ACCOUNT_JSON.');
}

function requireServices(res) {
  if (!mpClient) {
    res.status(503).json({ success: false, error: 'Mercado Pago no está configurado en el servidor.' });
    return false;
  }
  if (!firestore || !firebaseAuth) {
    res.status(503).json({ success: false, error: 'Firebase Admin no está configurado en el servidor.' });
    return false;
  }
  return true;
}

async function authenticatedUser(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) throw new Error('AUTH_REQUIRED');
  const decoded = await firebaseAuth.verifyIdToken(header.slice(7));
  if (!decoded.email) throw new Error('AUTH_EMAIL_REQUIRED');
  return decoded;
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
    optionsByName.set(String(data.name || data.nombre || '').trim().toLowerCase(), data);
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
      unitPrice = money(banner.promoPrice);
      name = String(banner.title || '').slice(0, 160);
      if (!(unitPrice > 0)) throw new Error('Precio de promoción inválido.');
      itemId = 'promo_' + bannerSnap.id;
    } else {
      if (!itemId || itemId.startsWith('banner_')) throw new Error('No se pudo identificar un producto del carrito.');
      const productSnap = await firestore.collection('productos').doc(itemId).get();
      if (!productSnap.exists) throw new Error('Uno de los productos ya no existe.');
      const product = productSnap.data();
      if (product.activo === false) throw new Error('Uno de los productos no está disponible.');
      const basePrice = money(product.price ?? product.precio ?? 0);
      const discount = Math.max(0, Math.min(100, Number(product.discount || 0)));
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
  const signatureHeader = req.get('x-signature') || '';
  const requestId = req.get('x-request-id') || '';
  const dataId = req.query['data.id'] || req.query.id || req.body?.data?.id;
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret || !signatureHeader || !requestId || !dataId) return false;

  const parts = Object.fromEntries(signatureHeader.split(',').map(part => part.trim().split('=')));
  const ts = parts.ts;
  const received = parts.v1;
  if (!ts || !received || !/^\d+$/.test(ts)) return false;
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return false;

  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(received, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
    if (existingOrder.exists && String(existingOrder.data().paymentId) === String(paymentId)) {
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
  if (pending.preferenceId && payment.preference_id && String(payment.preference_id) !== String(pending.preferenceId)) {
    return { verified: false, reason: 'La preferencia del pago no coincide con el pedido.' };
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
  res.json({ ok: true, mercadoPagoConfigured: Boolean(mpClient), firebaseConfigured: Boolean(firestore && firebaseAuth) });
});

app.post('/api/crear-preferencia', async (req, res) => {
  try {
    if (!requireServices(res)) return;
    const user = await authenticatedUser(req);
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
        notification_url: 'https://masayfan-backend.onrender.com/api/webhook',
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
    if (!paymentId || !reference) return res.status(400).json({ verified: false, error: 'Faltan datos para verificar el pago.' });
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
    const paymentId = req.query['data.id'] || req.body?.data?.id;
    if (type !== 'payment' || !paymentId) return res.sendStatus(200);

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
