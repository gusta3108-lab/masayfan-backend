'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  resolveOrderChatParticipant,
  isOrderChatClosed,
  normalizeOrderChatMessage
} = require('../lib/order-chat');

const courierDocumentId = email => crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');

function fakeFirestore({ admins = [], couriers = {} } = {}) {
  return {
    collection(name) {
      return {
        doc(id) {
          const value = name === 'administradores'
            ? (admins.includes(id) ? {} : null)
            : name === 'repartidores'
              ? (couriers[id] || null)
              : null;
          return {
            collectionName: name,
            get: async () => ({
              exists: value !== null,
              data: () => value || {}
            })
          };
        }
      };
    }
  };
}

test('the order owner can access their private chat by normalized account email', async () => {
  const participant = await resolveOrderChatParticipant({
    user: { email_verified: true, email: ' CLIENTE@example.com ' },
    order: { userEmail: 'cliente@example.com', clientName: '  Ana   Pérez ' },
    firestore: fakeFirestore(),
    courierDocumentId
  });
  assert.deepEqual(participant, { role: 'customer', name: 'Ana Pérez', canSend: true });
});

test('participant display names never expose phone-like digit sequences', async () => {
  const participant = await resolveOrderChatParticipant({
    user: { email_verified: true, email: 'cliente@example.com' },
    order: { userEmail: 'cliente@example.com', clientName: 'Ana Pérez +54 9 11 2345-6789' },
    firestore: fakeFirestore(),
    courierDocumentId
  });
  assert.equal(participant.name, 'Ana Pérez');
});

test('a different customer cannot read or send messages in another order chat', async () => {
  await assert.rejects(
    resolveOrderChatParticipant({
      user: { email_verified: true, email: 'other@example.com' },
      order: { userEmail: 'owner@example.com', delivery: {} },
      firestore: fakeFirestore(),
      courierDocumentId
    }),
    error => error.message === 'CHAT_FORBIDDEN'
  );
});

test('only the active courier assigned to this exact order can access its chat', async () => {
  const email = 'courier@example.com';
  const id = courierDocumentId(email);
  const participant = await resolveOrderChatParticipant({
    user: { email, email_verified: true },
    order: { delivery: { courierId: id, courierName: 'Repartidor asignado' } },
    firestore: fakeFirestore({ couriers: { [id]: { email, name: 'Perfil', active: true } } }),
    courierDocumentId
  });
  assert.deepEqual(participant, { role: 'courier', name: 'Repartidor asignado', canSend: true });
});

test('inactive, mismatched or unassigned couriers are denied', async () => {
  const email = 'courier@example.com';
  const id = courierDocumentId(email);
  const cases = [
    { courier: { email, active: false }, assignedId: id },
    { courier: { email: 'other@example.com', active: true }, assignedId: id },
    { courier: { email, active: true }, assignedId: 'different-courier' },
    { courier: null, assignedId: id }
  ];
  for (const item of cases) {
    await assert.rejects(
      resolveOrderChatParticipant({
        user: { email },
        order: { delivery: { courierId: item.assignedId } },
        firestore: fakeFirestore({ couriers: item.courier ? { [id]: item.courier } : {} }),
        courierDocumentId
      }),
      error => error.message === 'CHAT_FORBIDDEN'
    );
  }
});

test('administrators can supervise chat but cannot send messages', async () => {
  const participant = await resolveOrderChatParticipant({
    user: { email_verified: true, email: 'ADMIN@example.com' },
    order: {},
    firestore: fakeFirestore({ admins: ['admin@example.com'] }),
    courierDocumentId
  });
  assert.deepEqual(participant, { role: 'admin', name: 'Administración', canSend: false });
});


test('message authorization reads admin and courier membership inside the sending transaction', async () => {
  const email = 'courier@example.com';
  const id = courierDocumentId(email);
  const firestore = fakeFirestore({
    couriers: { [id]: { email, name: 'Repartidor', active: true } }
  });
  const transactionReads = [];
  const transaction = {
    get: async ref => {
      transactionReads.push(ref.collectionName);
      return ref.get();
    }
  };
  const participant = await resolveOrderChatParticipant({
    user: { email },
    order: { delivery: { courierId: id } },
    firestore,
    courierDocumentId,
    transaction
  });
  assert.equal(participant.role, 'courier');
  assert.deepEqual(transactionReads, ['administradores', 'repartidores']);
});

test('order chat closes when delivery is unassigned, completed, rejected or cancelled', () => {
  assert.equal(isOrderChatClosed({ delivery: { courierId: 'c1', status: 'assigned' }, status: 'listo' }), false);
  assert.equal(isOrderChatClosed({ delivery: { courierId: 'c1', status: 'issue' }, status: 'listo' }), false);
  assert.equal(isOrderChatClosed({ delivery: { courierId: 'c1', status: 'delivered' }, status: 'finalizado' }), true);
  assert.equal(isOrderChatClosed({ delivery: { courierId: 'c1', status: 'assigned' }, status: 'rechazado' }), true);
  assert.equal(isOrderChatClosed({ delivery: { courierId: 'c1', status: 'cancelled' }, status: 'listo' }), true);
  assert.equal(isOrderChatClosed({ delivery: { status: 'assigned' }, status: 'listo' }), true);
});

test('chat message validation trims text and enforces a 1000-character limit', () => {
  assert.equal(normalizeOrderChatMessage('  Hola  '), 'Hola');
  assert.throws(() => normalizeOrderChatMessage('   '), error => error.message === 'CHAT_MESSAGE_INVALID');
  assert.throws(() => normalizeOrderChatMessage('x'.repeat(1001)), error => error.message === 'CHAT_MESSAGE_INVALID');
  assert.throws(() => normalizeOrderChatMessage({ text: 'Hola' }), error => error.message === 'CHAT_MESSAGE_INVALID');
});
