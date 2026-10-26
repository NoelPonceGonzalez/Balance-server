import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { combineSeries } from './wallet-series.ts';

describe('gráfica de una cartera', () => {
  it('suma cada apartado y arrastra el último precio hasta hoy', () => {
    const points = combineSeries([
      { values: new Map([['2026-10-01', 100], ['2026-10-03', 130]]), current: 140 },
      { values: new Map([['2026-10-02', 50]]), current: 55 },
    ], '2026-10-04');
    assert.deepEqual(points, [
      { day: '2026-10-01', eur: 100 },
      { day: '2026-10-02', eur: 150 },
      { day: '2026-10-03', eur: 180 },
      { day: '2026-10-04', eur: 195 },
    ]);
  });
});
