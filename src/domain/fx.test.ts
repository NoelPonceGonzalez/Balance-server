import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { currencyMove, previousWeekday } from './fx.ts';

describe('currencyMove', () => {
  it('marca por debajo la moneda de la que el euro compra más unidades', () => {
    const move = currencyMove(1.1, 1);
    assert.ok(move != null && move < 0);
  });

  it('marca por encima la moneda de la que el euro compra menos unidades', () => {
    const move = currencyMove(0.9, 1);
    assert.ok(move != null && move > 0);
  });

  it('se queda en cero si el cambio no se ha movido', () => {
    assert.equal(currencyMove(1.08, 1.08), 0);
  });
});

describe('previousWeekday', () => {
  it('salta el fin de semana', () => {
    assert.equal(previousWeekday('2026-10-30'), '2026-10-29');
    assert.equal(previousWeekday('2026-10-26'), '2026-10-23');
  });
});
