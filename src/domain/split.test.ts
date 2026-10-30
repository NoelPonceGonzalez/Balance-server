import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { netsAfterConfirmed, splitTrip, transfersOf, type SplitPerson } from './split.ts';

function person(id: string, contributed = 0): SplitPerson {
  return { id, name: id, color: '#000', contributed };
}

describe('splitTrip', () => {
  it('empieza en paz si han puesto lo mismo y nadie ha pagado un gasto', () => {
    const split = splitTrip([person('a', 40), person('b', 40)], []);
    assert.equal(split.totalSpent, 0);
    assert.deepEqual(split.people.map((item) => item.net), [0, 0]);
    assert.equal(split.transfers.length, 0);
  });

  it('quien ha puesto de más queda a un lado y el otro le devuelve la mitad', () => {
    const split = splitTrip([person('ana', 100), person('luis', 0)], []);
    const ana = split.people.find((item) => item.id === 'ana');
    const luis = split.people.find((item) => item.id === 'luis');
    assert.equal(ana?.net, 50);
    assert.equal(luis?.net, -50);
    assert.deepEqual(split.transfers, [{ fromId: 'luis', from: 'luis', toId: 'ana', to: 'ana', amount: 50 }]);
  });

  it('un gasto mueve la barra hacia quien lo ha pagado', () => {
    const split = splitTrip([person('ana', 40), person('luis', 40)], [{ paidBy: 'ana', amount: 60 }]);
    assert.equal(split.totalSpent, 60);
    assert.equal(split.people.find((item) => item.id === 'ana')?.net, 30);
    assert.equal(split.people.find((item) => item.id === 'luis')?.net, -30);
    assert.equal(split.transfers[0]?.amount, 30);
    assert.equal(split.transfers[0]?.fromId, 'luis');
  });

  it('reparte un céntimo de más sin perderlo entre tres', () => {
    const split = splitTrip([person('a'), person('b'), person('c')], [{ paidBy: 'a', amount: 10.01 }]);
    const nets = split.people.map((item) => Math.round(item.net * 100));
    assert.equal(nets.reduce((sum, net) => sum + net, 0), 0);
    assert.equal(split.transfers.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), 667);
  });

  it('con diez personas, las nueve le devuelven su parte a quien pagó', () => {
    const members = Array.from({ length: 10 }, (_, index) => person(String(index)));
    const split = splitTrip(members, [{ paidBy: '0', amount: 100 }]);
    assert.equal(split.people[0]?.net, 90);
    assert.equal(split.transfers.length, 9);
    assert.ok(split.transfers.every((row) => row.toId === '0' && row.amount === 10));
    const back = split.transfers.reduce((sum, row) => sum + row.amount, 0);
    assert.equal(back, 90);
  });

  it('un gasto solo entre dos no mueve a quien no entra', () => {
    const split = splitTrip(
      [person('ana'), person('luis'), person('carlos')],
      [{ paidBy: 'ana', amount: 60, splitAmong: ['ana', 'luis'] }],
    );
    assert.equal(split.people.find((item) => item.id === 'ana')?.net, 30);
    assert.equal(split.people.find((item) => item.id === 'luis')?.net, -30);
    assert.equal(split.people.find((item) => item.id === 'carlos')?.net, 0);
    assert.equal(split.transfers.length, 1);
  });

  it('un pago confirmado baja la deuda que queda', () => {
    const split = splitTrip([person('ana', 100), person('luis', 0)], []);
    const left = netsAfterConfirmed(split.people, [{ fromId: 'luis', toId: 'ana', amount: 20 }]);
    assert.equal(left.find((item) => item.id === 'luis')?.net, -30);
    assert.equal(left.find((item) => item.id === 'ana')?.net, 30);
    assert.deepEqual(transfersOf(left), [{ fromId: 'luis', from: 'luis', toId: 'ana', to: 'ana', amount: 30 }]);
  });
});
