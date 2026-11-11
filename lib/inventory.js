'use strict';

const stockRequirements = items => {
  const totals = new Map();
  for (const item of items || []) {
    const productId = String(item.stockProductId || '');
    if (!productId) continue;
    totals.set(productId, (totals.get(productId) || 0) + Number(item.qty));
  }
  return [...totals.entries()].map(([productId, qty]) => ({ productId, qty }));
};

function createInventoryService({ firestore, admin }) {
  if (!firestore || !admin) throw new Error('Firestore y Firebase Admin son obligatorios.');

  async function reserveInventory(transaction, items) {
    const requirements = stockRequirements(items);
    const refs = requirements.map(item => firestore.collection('productos').doc(item.productId));
    const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
    requirements.forEach((item, index) => {
      const snap = snapshots[index];
      if (!snap.exists) throw new Error('Uno de los productos ya no existe.');
      const product = snap.data();
      if (product.stockManaged !== true && !Object.prototype.hasOwnProperty.call(product, 'stockQuantity')) return;
      const quantity = Number(product.stockQuantity ?? 0);
      const reserved = Number(product.stockReserved ?? 0);
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
        if (product.stockManaged !== true && !Object.prototype.hasOwnProperty.call(product, 'stockQuantity')) return;
        const reserved = Number(product.stockReserved ?? 0);
        if (!Number.isSafeInteger(reserved) || reserved < item.qty) {
          throw new Error('No coincide el inventario reservado para liberar el pago pendiente.');
        }
        transaction.update(refs[index], { stockReserved: reserved - item.qty });
      });
      transaction.update(pendingRef, {
        inventoryReleased: true,
        inventoryReleasedAt: admin.firestore.FieldValue.serverTimestamp(),
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
      if (product.stockManaged !== true && !Object.prototype.hasOwnProperty.call(product, 'stockQuantity')) return;
      const quantity = Number(product.stockQuantity ?? 0);
      const reserved = Number(product.stockReserved ?? 0);
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

  return { stockRequirements, reserveInventory, releasePendingInventory, completeInventorySale };
}

module.exports = { stockRequirements, createInventoryService };
