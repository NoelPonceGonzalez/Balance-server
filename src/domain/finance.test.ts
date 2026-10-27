import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addDays,
  balanceMarked,
  analyzeMovements,
  applyMovementToBooks,
  assertNoSecret,
  forecastPlan,
  planMonths,
  type SavingsPlanInput,
  movementFingerprint,
  revertEffects,
  pnlSlices,
  summarizeExtras,
  valuePortfolio,
  variationFromSnapshots,
  type AccountSnap,
  type Books,
  type HoldingSnap,
} from './finance.ts';

function account(partial: Partial<AccountSnap> & Pick<AccountSnap, 'id' | 'name' | 'kind' | 'tracking' | 'balance'>): AccountSnap {
  return {
    currency: 'EUR',
    eurPerUnit: null,
    updatedAt: null,
    ...partial,
  };
}

function holding(partial: Partial<HoldingSnap> & Pick<HoldingSnap, 'id' | 'accountId' | 'name'>): HoldingSnap {
  return {
    assetClass: 'etf',
    currency: 'EUR',
    quantity: 1,
    unitMarketValue: null,
    costBasis: null,
    eurPerUnit: null,
    valuedAt: null,
    ...partial,
  };
}

describe('patrimonio', () => {
  it('suma efectivo e inversiones y no usa el coste como precio', () => {
    const portfolio = valuePortfolio(
      [
        account({ id: 'b', name: 'Banco', kind: 'bank', tracking: 'balance', balance: 950 }),
        account({ id: 'c', name: 'Efectivo', kind: 'cash', tracking: 'balance', balance: 80 }),
        account({ id: 'tr', name: 'Trade Republic', kind: 'broker', tracking: 'positions', balance: 100 }),
      ],
      [holding({ id: 'etf', accountId: 'tr', name: 'MSCI World', quantity: 10, unitMarketValue: 55, costBasis: 500 })],
    );
    assert.equal(portfolio.netWorth.eur, 1680);
    assert.equal(portfolio.netWorth.complete, true);
    assert.equal(portfolio.available.eur, 1130);
    assert.equal(portfolio.invested.eur, 550);
    assert.equal(portfolio.unrealized.eur, 50);
    assert.equal(portfolio.unrealized.complete, true);
  });

  it('no cuenta dos veces un saldo que ya incluye los activos', () => {
    const portfolio = valuePortfolio(
      [account({ id: 'tr', name: 'Trade Republic', kind: 'broker', tracking: 'balance', balance: 1000 })],
      [holding({ id: 'etf', accountId: 'tr', name: 'MSCI World', unitMarketValue: 400, costBasis: 300 })],
    );
    assert.equal(portfolio.netWorth.eur, 1000);
    assert.equal(portfolio.invested.eur, 1000);
    assert.equal(portfolio.unrealized.eur, 0);
  });

  it('deja fuera un bien sin valor de mercado y no lo valora al coste', () => {
    const portfolio = valuePortfolio(
      [account({ id: 'o', name: 'Casa', kind: 'other', tracking: 'positions', balance: 0 })],
      [holding({ id: 'bike', accountId: 'o', name: 'Bici', assetClass: 'personal_good', costBasis: 800 })],
    );
    assert.equal(portfolio.netWorth.eur, 0);
    assert.equal(portfolio.netWorth.complete, false);
    assert.equal(portfolio.personalGoods.eur, 0);
    assert.match(portfolio.warnings.join(' '), /no tiene valor de mercado/);
  });

  it('deja fuera divisas sin tipo de cambio manual', () => {
    const portfolio = valuePortfolio(
      [account({ id: 'usd', name: 'Dólares', kind: 'cash', tracking: 'balance', balance: 100, currency: 'USD' })],
      [],
    );
    assert.equal(portfolio.netWorth.eur, 0);
    assert.equal(portfolio.netWorth.complete, false);
  });

  it('convierte con el tipo de cambio manual', () => {
    const portfolio = valuePortfolio(
      [account({ id: 'usd', name: 'Dólares', kind: 'cash', tracking: 'balance', balance: 100, currency: 'USD', eurPerUnit: 0.9 })],
      [],
    );
    assert.equal(portfolio.netWorth.eur, 90);
    assert.equal(portfolio.netWorth.complete, true);
  });

  it('separa la ganancia y la pérdida de cada activo y deja en blanco lo que no se puede calcular', () => {
    const slices = pnlSlices(
      [
        account({ id: 'tr', name: 'Trade Republic', kind: 'broker', tracking: 'positions', balance: 0 }),
        account({ id: 'b', name: 'Banco', kind: 'bank', tracking: 'balance', balance: 100 }),
      ],
      [
        holding({ id: 'up', accountId: 'tr', name: 'Seiko', quantity: 1, unitMarketValue: 250, costBasis: 200 }),
        holding({ id: 'down', accountId: 'tr', name: 'CS2', quantity: 2, unitMarketValue: 10, costBasis: 40 }),
        holding({ id: 'open', accountId: 'tr', name: 'Pandora', quantity: 1, costBasis: 80 }),
        holding({ id: 'cash', accountId: 'b', name: 'No cuenta', quantity: 1, unitMarketValue: 10, costBasis: 5 }),
      ],
    );
    assert.deepEqual(
      slices.map((slice) => [slice.label, slice.eur]),
      [
        ['Seiko', 50],
        ['CS2', -20],
        ['Pandora', null],
      ],
    );
  });

  it('suma las inversiones extra y solo calcula la ganancia si hay coste', () => {
    const summary = summarizeExtras([
      { id: '1', place: 'cs2', name: 'Skins', valueEur: 400, costEur: 250 },
      { id: '2', place: 'tf2', name: 'TF2', valueEur: 80, costEur: null },
      { id: '3', place: 'ledger', name: 'Ledger', valueEur: 0, costEur: null },
    ]);
    assert.equal(summary.total, 480);
    assert.equal(summary.allocation?.eur, 480);
    assert.deepEqual(
      summary.pnl.map((item) => [item.label, item.eur]),
      [
        ['Skins', 150],
        ['TF2', null],
        ['Ledger', null],
      ],
    );
  });
});

describe('movimientos', () => {
  it('no trata la transferencia como ingreso ni como ganancia', () => {
    const flow = analyzeMovements(
      [
        { id: '1', type: 'transfer', date: '2026-02-01', amount: 30, currency: 'EUR', eurPerUnit: null, accountId: 'b', counterAccountId: 'c' },
        { id: '2', type: 'income', date: '2026-02-02', amount: 100, currency: 'EUR', eurPerUnit: null, accountId: 'b' },
        { id: '3', type: 'expense', date: '2026-02-03', amount: 20, currency: 'EUR', eurPerUnit: null, accountId: 'b' },
        { id: '4', type: 'buy', date: '2026-02-04', amount: 500, currency: 'EUR', eurPerUnit: null, accountId: 'tr' },
        { id: '5', type: 'reward', date: '2026-02-05', amount: 4, currency: 'EUR', eurPerUnit: null, accountId: 'b' },
      ],
      '2026-02-01',
      '2026-02-28',
    );
    assert.equal(flow.contributions.eur, 80);
    assert.equal(flow.contributions.complete, true);
    assert.equal(flow.realized.eur, 4);
    assert.equal(flow.realized.complete, true);
  });

  it('marca la venta sin coste como ganancia incompleta', () => {
    const missing = analyzeMovements(
      [{ id: 's', type: 'sell', date: '2026-03-01', amount: 120, currency: 'EUR', eurPerUnit: null, accountId: 'tr' }],
      null,
      null,
    );
    assert.equal(missing.realized.complete, false);
    assert.equal(missing.realized.eur, 0);

    const known = analyzeMovements(
      [{ id: 's', type: 'sell', date: '2026-03-01', amount: 120, currency: 'EUR', eurPerUnit: null, accountId: 'tr', costOfSold: 90 }],
      null,
      null,
    );
    assert.equal(known.realized.eur, 30);
    assert.equal(known.realized.complete, true);
    assert.equal(known.contributions.eur, 0);
  });

  it('actualiza saldos y deshace la operación', () => {
    const books: Books = {
      accounts: [
        account({ id: 'b', name: 'Banco', kind: 'bank', tracking: 'balance', balance: 1000 }),
        account({ id: 'c', name: 'Efectivo', kind: 'cash', tracking: 'balance', balance: 50 }),
        account({ id: 'tr', name: 'TR', kind: 'broker', tracking: 'positions', balance: 600 }),
      ],
      holdings: [holding({ id: 'etf', accountId: 'tr', name: 'MSCI', quantity: 0, costBasis: null })],
    };

    const spent = applyMovementToBooks(books, { type: 'expense', amount: 20, accountId: 'b', applyToBalances: true });
    assert.ok(!('error' in spent));
    if ('error' in spent) return;
    assert.equal(spent.books.accounts[0].balance, 980);

    const moved = applyMovementToBooks(spent.books, {
      type: 'transfer',
      amount: 30,
      accountId: 'b',
      counterAccountId: 'c',
      applyToBalances: true,
    });
    assert.ok(!('error' in moved));
    if ('error' in moved) return;
    assert.equal(moved.books.accounts.find((a) => a.id === 'b')?.balance, 950);
    assert.equal(moved.books.accounts.find((a) => a.id === 'c')?.balance, 80);

    const bought = applyMovementToBooks(moved.books, {
      type: 'buy',
      amount: 500,
      accountId: 'tr',
      holdingId: 'etf',
      quantity: 10,
      applyToBalances: true,
    });
    assert.ok(!('error' in bought));
    if ('error' in bought) return;
    assert.equal(bought.books.accounts.find((a) => a.id === 'tr')?.balance, 100);
    assert.equal(bought.books.holdings[0].quantity, 10);
    assert.equal(bought.books.holdings[0].costBasis, 500);

    const sold = applyMovementToBooks(bought.books, {
      type: 'sell',
      amount: 60,
      accountId: 'tr',
      holdingId: 'etf',
      quantity: 1,
      applyToBalances: true,
    });
    assert.ok(!('error' in sold));
    if ('error' in sold) return;
    assert.equal(sold.effects.costOfSold, 50);
    assert.equal(sold.books.holdings[0].quantity, 9);
    assert.equal(sold.books.holdings[0].costBasis, 450);

    const back = revertEffects(sold.books, sold.effects);
    assert.ok(!('error' in back));
    if ('error' in back) return;
    assert.equal(back.holdings[0].quantity, 10);
    assert.equal(back.holdings[0].costBasis, 500);
    assert.equal(back.accounts.find((a) => a.id === 'tr')?.balance, 100);
  });

  it('rechaza vender de más y pegar una frase semilla', () => {
    const books: Books = {
      accounts: [account({ id: 'tr', name: 'TR', kind: 'broker', tracking: 'positions', balance: 0 })],
      holdings: [holding({ id: 'etf', accountId: 'tr', name: 'MSCI', quantity: 1 })],
    };
    const sold = applyMovementToBooks(books, {
      type: 'sell',
      amount: 10,
      accountId: 'tr',
      holdingId: 'etf',
      quantity: 2,
      applyToBalances: true,
    });
    assert.ok('error' in sold);

    assert.ok(assertNoSecret('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'));
    assert.equal(assertNoSecret('0xabc123'), null);
  });

  it('detecta el mismo movimiento', () => {
    const a = movementFingerprint({ accountId: 'b', type: 'expense', date: '2026-04-01T10:00:00.000Z', amount: 12.5, currency: 'eur', description: '  Café  solo ' });
    const b = movementFingerprint({ accountId: 'b', type: 'expense', date: '2026-04-01', amount: 12.5, currency: 'EUR', description: 'café solo' });
    assert.equal(a, b);
  });
});

describe('variación', () => {
  it('no inventa la variación si no hay un saldo anterior', () => {
    const none = variationFromSnapshots([{ day: '2026-04-10', netWorthEur: 100 }], '2026-04-10', 100, '2026-04-03');
    assert.equal(none.available, false);
    const ok = variationFromSnapshots(
      [
        { day: '2026-04-01', netWorthEur: 1000 },
        { day: '2026-04-08', netWorthEur: 1100 },
      ],
      '2026-04-10',
      1100,
      '2026-04-03',
    );
    assert.equal(ok.available, true);
    assert.equal(ok.baseDay, '2026-04-01');
    assert.equal(ok.amount, 100);
    assert.equal(ok.percent, 10);
  });

  it('no divide entre cero', () => {
    const change = variationFromSnapshots([{ day: '2026-04-01', netWorthEur: 0 }], '2026-04-10', 50, '2026-04-01');
    assert.equal(change.amount, 50);
    assert.equal(change.percent, null);
  });
});

describe('planes de ahorro', () => {
  const plan: SavingsPlanInput = {
    openingBalance: 5000,
    startDate: '2026-01-15',
    targetAmount: 10000,
    targetDate: '2026-07-15',
    monthlySavings: 200,
    recurring: [{ amount: 50, dayOfMonth: 1 }],
    plannedExpenses: [],
    incomes: [
      { amount: 1000, date: '2026-03-01', status: 'confirmed' },
      { amount: 500, date: '2026-03-01', status: 'expected' },
    ],
    scenarios: [{ id: 's1', name: 'Apretar', monthlySavings: 400 }],
  };

  it('no mete el ingreso esperado en el saldo previsto confirmado', () => {
    const onStart = forecastPlan(plan, 5000, '2026-01-15');
    assert.equal(onStart.plannedToday, 5000);

    const beforeSavings = forecastPlan(plan, 5000, '2026-02-14');
    assert.equal(beforeSavings.plannedToday, 4950);

    const onSavings = forecastPlan(plan, 5150, '2026-02-15');
    assert.equal(onSavings.plannedToday, 5150);
    assert.equal(onSavings.plannedWithExpectedToday, 5150);

    const payday = forecastPlan(plan, 6100, '2026-03-01');
    assert.equal(payday.plannedToday, 6100);
    assert.equal(payday.plannedWithExpectedToday, 6600);
  });

  it('calcula la desviación y el ahorro extra para recuperar la fecha', () => {
    const behind = forecastPlan(plan, 5000, '2026-02-15');
    assert.equal(behind.plannedToday, 5150);
    assert.equal(behind.deviationEur, -150);
    assert.equal(behind.onTrack, false);
    assert.equal(behind.savingsEventsRemaining, 5);
    assert.equal(behind.gapAtTarget, 3250);
    assert.equal(behind.extraMonthlyToRecover, 650);
    assert.ok(behind.estimatedDate);
    assert.equal(behind.scenarios[0].balanceAtTarget > 5000, true);
    assert.match(behind.notes.join(' '), /no forman parte del patrimonio real/);
  });

  it('el ahorro fijo entra el día elegido y antes no mueve el saldo', () => {
    const base: SavingsPlanInput = {
      openingBalance: 1000,
      startDate: '2026-10-01',
      targetAmount: 10000,
      targetDate: '2026-12-31',
      monthlySavings: 1150,
      salary: 1350,
      savingsDay: 31,
      recurring: [],
      plannedExpenses: [{ name: 'Entrenador', amount: 165, date: '2027-01-15', automatic: true }],
      incomes: [],
    };
    const before = planMonths(base, '2026-10-26');
    const october = before.find((month) => month.month === '2026-10');
    const savings = october?.lines.find((line) => line.label.includes('Nómina'));
    assert.equal(savings?.automatic, true);
    assert.equal(savings?.paid, false);
    assert.equal(savings?.balance, 1000);
    assert.equal(october?.lines.at(-1)?.balance, 1000);
    assert.equal(before.find((month) => month.month === '2026-11')?.lines[0]?.balance, 1000);
    assert.equal(before.find((month) => month.month === '2026-11')?.lines.at(-1)?.balance, 1000);
    assert.equal(before.at(-1)?.lines.at(-1)?.balance, 1000);
    const onDay = planMonths(base, '2026-10-31');
    const paid = onDay.find((month) => month.month === '2026-10')?.lines.find((line) => line.label.includes('Nómina'));
    assert.equal(paid?.paid, true);
    assert.equal(paid?.balance, 2150);
    assert.equal(onDay.find((month) => month.month === '2026-10')?.lines.at(-1)?.balance, 2150);
    assert.equal(onDay.find((month) => month.month === '2026-11')?.lines[0]?.balance, 2150);
  });

  it('un gasto ya metido en el efectivo se ve y no se vuelve a restar', () => {
    const plan: SavingsPlanInput = {
      openingBalance: 3246.98,
      startDate: '2026-10-01',
      targetAmount: 10000,
      targetDate: '2026-12-31',
      monthlySavings: 1150,
      salary: 1350,
      savingsDay: 31,
      recurring: [],
      plannedExpenses: [{ name: 'Entrenador', amount: 165, date: '2026-10-14', automatic: true, absorbed: true }],
      incomes: [],
    };
    const months = planMonths(plan, '2026-10-26');
    const october = months.find((month) => month.month === '2026-10');
    const trainerAt = october?.lines.findIndex((line) => line.label === 'Entrenador') ?? -1;
    const currentAt = october?.lines.findIndex((line) => line.label === 'Saldo actual') ?? -1;
    assert.equal(october?.lines[trainerAt]?.absorbed, true);
    assert.equal(october?.lines[trainerAt]?.paid, true);
    assert.equal(october?.lines[currentAt]?.balance, 3246.98);
    assert.equal(trainerAt < currentAt, true);
    assert.equal(october?.lines.at(-1)?.balance, 3246.98);
    assert.equal(forecastPlan(plan, 3246.98, '2026-10-26').plannedToday, 3246.98);
  });

  it('un fijo pasado no entra hasta que se confirma', () => {
    const plan: SavingsPlanInput = {
      openingBalance: 1000,
      startDate: '2026-10-01',
      targetAmount: 10000,
      targetDate: '2026-12-31',
      monthlySavings: 1150,
      salary: 1350,
      savingsDay: 31,
      recurring: [],
      plannedExpenses: [],
      incomes: [],
      settled: [],
      includedUntil: '2026-10-26',
    };
    const waiting = planMonths(plan, '2026-10-31');
    const october = waiting.find((month) => month.month === '2026-10');
    const savings = october?.lines.find((line) => line.label.includes('Nómina'));
    assert.equal(savings?.paid, false);
    assert.equal(october?.lines.at(-1)?.balance, 1000);
    const confirmed = planMonths({ ...plan, settled: [{ key: 'savings:2026-10-31', done: true, amount: 1200 }] }, '2026-10-31');
    const paid = confirmed.find((month) => month.month === '2026-10')?.lines.find((line) => line.label.includes('Nómina'));
    assert.equal(paid?.paid, true);
    assert.equal(paid?.amount, 1200);
    assert.equal(confirmed.find((month) => month.month === '2026-10')?.lines.at(-1)?.balance, 2200);
  });

  it('marcar un gasto o un fijo lo suma o lo resta, y quitar la marca lo devuelve', () => {
    const plan: SavingsPlanInput = {
      openingBalance: 3246.98,
      startDate: '2026-10-01',
      targetAmount: 10000,
      targetDate: '2027-06-30',
      monthlySavings: 1150,
      salary: 1350,
      savingsDay: 31,
      settled: [],
      includedUntil: '2026-10-26',
      recurring: [{ id: 'gym', name: 'Gimnasio', amount: 40, dayOfMonth: 5, paidDates: [] }],
      plannedExpenses: [
        { id: 'trainer', name: 'Entrenador', amount: 165, date: '2026-10-14', automatic: true },
        { id: 'wraps', name: 'Muñequeras', amount: 55, date: '2026-10-23', paid: false },
        { id: 'gloves', name: 'Guantes', amount: 3200, date: '2026-12-01', paid: false },
      ],
      incomes: [{ id: 'xmas', name: 'Navidad', amount: 500, date: '2026-12-24', paid: false }],
    };
    const waiting = planMonths(plan, '2026-10-27');
    const october = waiting.find((month) => month.month === '2026-10');
    const trainer = october?.lines.find((line) => line.label === 'Entrenador');
    const wraps = october?.lines.find((line) => line.label === 'Muñequeras');
    const savings = october?.lines.find((line) => line.markKey === 'savings:2026-10-31');
    assert.equal(trainer?.absorbed, true);
    assert.equal(trainer?.paid, true);
    assert.ok(wraps);
    assert.equal(wraps?.absorbed === true, false);
    assert.equal(wraps?.paid, false);
    assert.equal(savings?.paid, false);
    assert.equal(october?.lines.at(-1)?.balance, 3246.98);
    assert.equal(balanceMarked(waiting, '2026-10-27', 3246.98), 3246.98);

    const marked = planMonths({
      ...plan,
      savingsPaid: ['2026-10-31'],
      recurring: [{ id: 'gym', name: 'Gimnasio', amount: 40, dayOfMonth: 5, paidDates: ['2026-11-05'] }],
      plannedExpenses: [
        { id: 'trainer', name: 'Entrenador', amount: 165, date: '2026-10-14', automatic: true },
        { id: 'wraps', name: 'Muñequeras', amount: 55, date: '2026-10-23', paid: true },
        { id: 'gloves', name: 'Guantes', amount: 3200, date: '2026-12-01', paid: true },
      ],
      incomes: [{ id: 'xmas', name: 'Navidad', amount: 500, date: '2026-12-24', paid: true }],
    }, '2026-10-27');
    assert.equal(balanceMarked(marked, '2026-10-27', 3246.98), 1601.98);
    const back = planMonths(plan, '2026-10-27');
    assert.equal(balanceMarked(back, '2026-10-27', 3246.98), 3246.98);
  });

  it('un gasto que empuja la llegada más allá de la fecha inicial cuenta como mes de más', () => {
    const base: SavingsPlanInput = {
      openingBalance: 0,
      startDate: '2026-10-01',
      targetAmount: 2000,
      targetDate: '2026-12-31',
      monthlySavings: 1000,
      savingsDay: 1,
      recurring: [],
      plannedExpenses: [],
      incomes: [],
    };
    const plain = forecastPlan(base, 0, '2026-10-01');
    assert.equal(plain.estimatedDate?.slice(0, 7), '2026-12');
    assert.equal(plain.extraMonths, 0);
    const late = forecastPlan({
      ...base,
      plannedExpenses: [{ name: 'Guantes', amount: 1000, date: '2026-11-15' }],
    }, 0, '2026-10-01');
    assert.equal(late.estimatedDate?.slice(0, 7), '2027-01');
    assert.equal(late.extraMonths, 1);
  });

  it('avanza los días sin salirse del calendario', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  });
});
