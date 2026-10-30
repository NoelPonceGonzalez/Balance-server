import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyPay, closingNote, payAsks, type PayRow } from './pays.js';

const row = (patch: Partial<PayRow> = {}): PayRow => ({
  fromId: 'luis',
  toId: 'marta',
  amount: 63,
  state: 'pending',
  rejected: false,
  ...patch,
});

describe('applyPay', () => {
  it('el que debe marca el pago y el otro lo confirma', () => {
    const claimed = applyPay(row(), 'luis', 'paid');
    assert.equal(claimed?.state, 'claimed');
    const done = applyPay(claimed as PayRow, 'marta', 'yes');
    assert.equal(done?.state, 'done');
  });

  it('si no ha llegado, vuelve atrás y se puede repetir', () => {
    const claimed = applyPay(row(), 'luis', 'paid') as PayRow;
    const back = applyPay(claimed, 'marta', 'no');
    assert.equal(back?.state, 'pending');
    assert.equal(back?.rejected, true);
    const again = applyPay(back as PayRow, 'luis', 'paid');
    assert.equal(again?.state, 'claimed');
    assert.equal(again?.rejected, false);
  });

  it('no deja actuar a quien no le toca', () => {
    assert.equal(applyPay(row(), 'marta', 'paid'), null);
    assert.equal(applyPay(row({ state: 'claimed' }), 'luis', 'yes'), null);
    assert.equal(applyPay(row({ state: 'done' }), 'marta', 'yes'), null);
  });
});

describe('payAsks', () => {
  it('pide primero el rechazo, luego la confirmación y al final el pago', () => {
    const names = new Map([['luis', 'Luis'], ['marta', 'Marta'], ['ana', 'Ana']]);
    const asks = payAsks('luis', [
      row({ fromId: 'ana', toId: 'luis', state: 'claimed' }),
      row({ rejected: true }),
      row({ fromId: 'luis', toId: 'ana', amount: 9 }),
    ], names);
    assert.deepEqual(asks.map((item) => item.role + item.otherName), ['payMarta', 'confirmAna', 'payAna']);
    assert.equal(asks[0].rejected, true);
  });
});

describe('closingNote', () => {
  it('resume lo que debe y a quién', () => {
    const note = closingNote('Fin de semana', 'luis', [{ id: 'luis', net: -63 }], [
      { fromId: 'luis', toId: 'marta', from: 'Luis', to: 'Marta', amount: 63 },
    ]);
    assert.match(note.title, /Debes/);
    assert.match(note.body, /Marta/);
  });
});
