import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fillBuys, investNotices, type InvestBuy, type InvestSlot, type InvestWatch } from './invest.ts';

const buys: InvestBuy[] = [
  { id: 'b1', asset: 'bitcoin', amount: 2000, date: '2026-11-20', done: false },
  { id: 'e1', asset: 'ethereum', amount: 500, date: '2026-11-20', done: false },
  { id: 'b2', asset: 'bitcoin', amount: 1000, date: '', done: false },
  { id: 'e2', asset: 'ethereum', amount: 500, date: '', done: false },
];

function watch(extra: Partial<InvestWatch> = {}): InvestWatch {
  return {
    dropPct: 5,
    risePct: 8,
    ratioAbove: 0.0298,
    zones: [{ asset: 'bitcoin', belowEur: 61300 }],
    refs: [
      { asset: 'bitcoin', priceEur: 66350, at: '2026-11-12' },
      { asset: 'ethereum', priceEur: 1848, at: '2026-11-12' },
    ],
    fired: [],
    ...extra,
  };
}

function run(prices: Record<string, number>, today = '2026-11-14', state = watch(), list = buys) {
  return investNotices({ planId: 'p', planName: 'Cripto', buys: list, watch: state, prices, today, stamp: 1 });
}

describe('investNotices', () => {
  it('no dice nada si el precio apenas se mueve', () => {
    const out = run({ bitcoin: 65000, ethereum: 1830 });
    assert.equal(out.notices.length, 0);
  });

  it('avisa el día antes y el mismo día de una tanda con fecha', () => {
    const eve = run({ bitcoin: 66000, ethereum: 1840 }, '2026-11-19');
    assert.deepEqual(eve.notices.map((item) => item.title), ['Mañana toca comprar 2.000 € de Bitcoin', 'Mañana toca comprar 500 € de Ethereum']);
    const day = run({ bitcoin: 66000, ethereum: 1840 }, '2026-11-20');
    assert.equal(day.notices[0].key, 'plan-inv:p:day:b1:2026-11-20');
    assert.match(day.notices[0].title, /^Hoy toca comprar/);
  });

  it('una caída del 5 % avisa una vez y vuelve a avisar al 10 %', () => {
    const first = run({ bitcoin: 62800, ethereum: 1840 });
    assert.equal(first.notices.length, 1);
    assert.match(first.notices[0].title, /Bitcoin baja un 5,4 %/);
    assert.match(first.notices[0].body, /Va por 62\.800 € \(referencia 66\.350 €\)\. Te quedan 3\.000 € para Bitcoin/);
    const again = run({ bitcoin: 62500, ethereum: 1840 }, '2026-11-14', watch({ fired: first.fired }));
    assert.equal(again.notices.length, 0);
    const deeper = run({ bitcoin: 59500, ethereum: 1760 }, '2026-11-14', watch({ fired: first.fired, zones: [] }));
    assert.equal(deeper.notices.length, 1);
    assert.match(deeper.notices[0].title, /10,3 %/);
  });

  it('la zona de compra avisa al entrar y se rearma al salir con margen', () => {
    const inside = run({ bitcoin: 61000, ethereum: 1840 }, '2026-11-14', watch({ dropPct: 0 }));
    assert.equal(inside.notices[0].title, 'Bitcoin entra en tu zona de compra');
    const still = run({ bitcoin: 61200, ethereum: 1840 }, '2026-11-14', watch({ dropPct: 0, fired: inside.fired }));
    assert.equal(still.notices.length, 0);
    const out = run({ bitcoin: 64000, ethereum: 1840 }, '2026-11-14', watch({ dropPct: 0, fired: inside.fired }));
    assert.ok(!out.fired.includes('zone:bitcoin'));
  });

  it('avisa cuando ETH/BTC pasa la línea de giro', () => {
    const out = run({ bitcoin: 66000, ethereum: 1980 });
    assert.equal(out.notices.length, 1);
    assert.equal(out.notices[0].title, 'Ethereum gana terreno a Bitcoin');
  });

  it('una subida fuerte pide revisar el plan', () => {
    const out = run({ bitcoin: 72000, ethereum: 1850 });
    assert.match(out.notices[0].title, /Bitcoin sube un 8,5 %/);
    assert.equal(out.notices[0].direction, 'up');
  });

  it('con todas las tandas hechas se calla', () => {
    const done = buys.map((buy) => ({ ...buy, done: true }));
    const out = run({ bitcoin: 50000, ethereum: 1500 }, '2026-11-20', watch(), done);
    assert.equal(out.notices.length, 0);
  });

  it('una tanda a medias solo pide lo que falta', () => {
    const half = buys.map((buy) => (buy.id === 'b1' ? { ...buy, spent: 1200 } : buy));
    const day = run({ bitcoin: 66000, ethereum: 1840 }, '2026-11-20', watch(), half);
    assert.equal(day.notices[0].title, 'Hoy toca comprar 800 € de Bitcoin');
  });
});

const slots: InvestSlot[] = buys.map((buy) => ({ id: buy.id, asset: buy.asset, amount: buy.amount, date: buy.date, manual: false, manualAt: '', manualPrice: null }));

function byId(fills: ReturnType<typeof fillBuys>) {
  return Object.fromEntries(fills.map((fill) => [fill.id, fill]));
}

describe('fillBuys', () => {
  it('la compra del día llena la tanda con fecha y saca el precio real', () => {
    const out = byId(fillBuys(slots, [{ id: 'm1', asset: 'bitcoin', date: '2026-11-20', eur: 2000, quantity: 0.03 }]));
    assert.equal(out.b1.done, true);
    assert.equal(out.b1.doneAt, '2026-11-20');
    assert.deepEqual(out.b1.movementIds, ['m1']);
    assert.ok(Math.abs((out.b1.priceEur as number) - 66666.67) < 0.01);
    assert.equal(out.b2.done, false);
  });

  it('dos compras pequeñas llenan la misma tanda', () => {
    const out = byId(fillBuys(slots, [
      { id: 'm1', asset: 'bitcoin', date: '2026-11-20', eur: 1000, quantity: 0.015 },
      { id: 'm2', asset: 'bitcoin', date: '2026-11-21', eur: 1000, quantity: 0.016 },
    ]));
    assert.equal(out.b1.done, true);
    assert.equal(out.b1.spent, 2000);
    assert.equal(out.b2.spent, 0);
  });

  it('una compra grande cubre varias tandas', () => {
    const out = byId(fillBuys(slots, [{ id: 'm1', asset: 'bitcoin', date: '2026-11-20', eur: 3000, quantity: 0.045 }]));
    assert.equal(out.b1.done, true);
    assert.equal(out.b2.done, true);
  });

  it('una compra antes de tiempo va a la tanda de aviso', () => {
    const out = byId(fillBuys(slots, [{ id: 'm1', asset: 'bitcoin', date: '2026-11-13', eur: 1000, quantity: 0.016 }]));
    assert.equal(out.b2.done, true);
    assert.equal(out.b1.spent, 0);
  });

  it('casi el importe cuenta como hecha y lo de más se queda en la tanda', () => {
    const out = byId(fillBuys(slots, [{ id: 'm1', asset: 'ethereum', date: '2026-11-20', eur: 510, quantity: 0.28 }]));
    assert.equal(out.e1.done, true);
    assert.equal(out.e1.spent, 510);
    assert.equal(out.e2.spent, 0);
  });

  it('sin movimientos la tanda vuelve a estar pendiente, salvo la marcada a mano', () => {
    const manual = slots.map((slot) => (slot.id === 'e1' ? { ...slot, manual: true, manualAt: '2026-11-20', manualPrice: 1800 } : slot));
    const out = byId(fillBuys(manual, []));
    assert.equal(out.b1.done, false);
    assert.equal(out.e1.done, true);
    assert.equal(out.e1.priceEur, 1800);
  });

  it('el movimiento de una tanda marcada a mano se le une y no gasta otra', () => {
    const manual = slots.map((slot) => (slot.id === 'b1' ? { ...slot, manual: true, manualAt: '2026-11-20', manualPrice: 66000 } : slot));
    const out = byId(fillBuys(manual, [{ id: 'm1', asset: 'bitcoin', date: '2026-11-20', eur: 2000, quantity: 0.03 }]));
    assert.deepEqual(out.b1.movementIds, ['m1']);
    assert.equal(out.b2.spent, 0);
  });
});
