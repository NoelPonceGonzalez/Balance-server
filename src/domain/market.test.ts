import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  downsample,
  eurPerForeignUnit,
  evaluateBand,
  evaluateLevel,
  pickAutoLink,
  rankCandidates,
  priceForHolding,
  priceInEur,
  sharesForLump,
  closestQuote,
  instantInMadrid,
  priceGrainNote,
  type Candidate,
} from './market.ts';

const fx = { USD: 1.08, GBP: 0.85 };

describe('cotizaciones', () => {
  it('pasa un precio en euros a la moneda del activo', () => {
    const eur = priceForHolding({ nativePrice: 100, nativeCurrency: 'EUR', priceEur: 100 }, 'EUR', fx);
    assert.deepEqual(eur, { unitMarketValue: 100, eurPerUnit: null });

    const usd = priceForHolding({ nativePrice: 108, nativeCurrency: 'USD', priceEur: 100 }, 'USD', fx);
    assert.ok(usd);
    assert.equal(usd.unitMarketValue, 108);
    assert.ok(Math.abs((usd.eurPerUnit ?? 0) - 100 / 108) < 1e-9);

    const gbp = priceForHolding({ nativePrice: 100, nativeCurrency: 'EUR', priceEur: 100 }, 'GBP', fx);
    assert.ok(gbp);
    assert.ok(Math.abs(gbp.unitMarketValue - 100 * 0.85) < 1e-9);
    assert.equal(eurPerForeignUnit('USD', fx), 1 / 1.08);
    const usdInEur = priceInEur(108, 'USD', fx);
    assert.ok(usdInEur != null && Math.abs(usdInEur - 100) < 1e-9);
  });

  it('no inventa un tipo de cambio que no está en la tabla', () => {
    assert.equal(priceForHolding({ nativePrice: 10, nativeCurrency: 'EUR', priceEur: 10 }, 'JPY', fx), null);
    assert.equal(priceInEur(10, 'JPY', {}), null);
  });

  it('enlaza Bitcoin y deja a un lado un ETF que cotiza en varias bolsas', () => {
    const coins: Candidate[] = [
      { source: 'coingecko', externalId: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', image: null, rank: 1 },
      { source: 'coingecko', externalId: 'bitcoin-trc20', symbol: 'BTC', name: 'Bitcoin TRC20', image: null, rank: 840 },
      { source: 'coingecko', externalId: 'other', symbol: 'BTC', name: 'Otro', image: null, rank: null },
    ];
    assert.equal(pickAutoLink('btc', coins)?.externalId, 'bitcoin');
    assert.equal(pickAutoLink('eth', coins), null);

    const listings: Candidate[] = [
      { source: 'yahoo', externalId: 'VWCE.DE', symbol: 'VWCE.DE', name: 'Vanguard', image: null, rank: null },
      { source: 'yahoo', externalId: 'VWCE.MI', symbol: 'VWCE.MI', name: 'Vanguard', image: null, rank: null },
    ];
    assert.equal(pickAutoLink('VWCE', listings), null);
    assert.equal(pickAutoLink('VWCE.DE', listings)?.externalId, 'VWCE.DE');
  });

  it('al buscar S&P deja el índice y aparta monedas que no coinciden', () => {
    const ranked = rankCandidates('S&P', [
      { source: 'coingecko', externalId: 'harry-bitcoin', symbol: 'BITCOIN', name: 'HarryPotterObamaSonic10Inu', image: null, rank: null, kind: 'crypto' },
      { source: 'coingecko', externalId: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', image: null, rank: 1, kind: 'crypto' },
      { source: 'coingecko', externalId: 'spyon', symbol: 'SPYON', name: 'SPDR S&P 500 ETF (Ondo Tokenized ETF)', image: null, rank: 80, kind: 'crypto' },
      { source: 'yahoo', externalId: 'SPY', symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', image: null, rank: null, kind: 'etf' },
      { source: 'yahoo', externalId: '^GSPC', symbol: '^GSPC', name: 'S&P 500', image: null, rank: null, kind: 'etf' },
    ]);
    assert.deepEqual(ranked.map((item) => item.externalId), ['^GSPC', 'SPY']);
  });

  it('avisa una sola vez al cruzar el umbral y se rearma al volver', () => {
    const quiet = evaluateBand(1.2, { thresholdPct: 3, armed: true });
    assert.equal(quiet.fire, null);
    assert.equal(quiet.armed, true);

    const up = evaluateBand(4.5, { thresholdPct: 3, armed: true });
    assert.equal(up.fire, 'up');
    assert.equal(up.armed, false);

    const still = evaluateBand(6, { thresholdPct: 3, armed: false });
    assert.equal(still.fire, null);
    assert.equal(still.armed, false);

    const reset = evaluateBand(-0.4, { thresholdPct: 3, armed: false });
    assert.equal(reset.armed, true);
    const down = evaluateBand(-3.1, { thresholdPct: 3, armed: true });
    assert.equal(down.fire, 'down');
  });

  it('avisa al cruzar un precio objetivo', () => {
    const below = evaluateLevel(90, { direction: 'below', target: 100, armed: true });
    assert.equal(below.fire, true);
    assert.equal(below.armed, false);
    assert.equal(evaluateLevel(80, { direction: 'below', target: 100, armed: false }).fire, false);
    assert.equal(evaluateLevel(110, { direction: 'below', target: 100, armed: false }).armed, true);
    assert.equal(evaluateLevel(null, { direction: 'above', target: 10, armed: true }).fire, false);
  });

  it('calcula lo recibido con el precio más cercano a la hora', () => {
    assert.equal(sharesForLump(500.92, 56847.12), Math.round((500.92 / 56847.12) * 1e8) / 1e8);
    assert.equal(sharesForLump(0, 10), null);
    const target = Date.parse('2026-02-11T09:07:00.000Z');
    const hit = closestQuote(
      [
        { at: target - 3_600_000, price: 100 },
        { at: target + 5 * 60_000, price: 110 },
      ],
      target,
    );
    assert.equal(hit?.price, 110);
    assert.equal(hit?.grain, 'hour');
    const daily = closestQuote(
      [
        { at: target - 86_400_000, price: 90 },
        { at: target + 86_400_000, price: 95 },
      ],
      target,
    );
    assert.equal(daily?.grain, 'day');
    assert.equal(priceGrainNote('day'), 'De esa hora no hay precio. Uso el del día.');
    assert.equal(instantInMadrid('2026-02-11T10:07', Date.parse('2026-10-26T00:00:00Z')).toISOString(), '2026-02-11T09:07:00.000Z');
    assert.equal(instantInMadrid('2026-07-15T10:07', Date.parse('2026-10-26T00:00:00Z')).toISOString(), '2026-07-15T08:07:00.000Z');
    assert.equal(closestQuote([], target), null);
  });

  it('reduce la serie sin perder los extremos del recorrido', () => {
    const series = Array.from({ length: 168 }, (_, index) => index);
    const compact = downsample(series, 42);
    assert.equal(compact.length, 42);
    assert.ok(compact[0] < 5);
    assert.ok(compact[compact.length - 1] > 160);
  });
});
