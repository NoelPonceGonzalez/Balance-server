import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateSkin, linkSkin, resolveSkinLink, seriesMove, type SkinSale } from './skins.ts';

const talon: SkinSale[] = [
  { usd: 3600, floatValue: 0.0083046, lowRank: 32, stickers: 0 },
  { usd: 2777.27, floatValue: 0.0084899, lowRank: 33, stickers: 0 },
  { usd: 3231.95, floatValue: 0.0071433, lowRank: 20, stickers: 0 },
  { usd: 2655.11, floatValue: 0.0157192, lowRank: 70, stickers: 0 },
];

describe('skins', () => {
  it('enlaza el Talon Black Pearl con su fase y el puesto del nombre', () => {
    const link = linkSkin('Talon Black Pearl #26', 0.00787745323);
    assert.deepEqual(link, {
      marketHashName: '★ Talon Knife | Doppler (Factory New)',
      paintIndex: 417,
      rank: 26,
    });
  });

  it('distingue los dos Printstream por el arma y el desgaste del float', () => {
    assert.equal(linkSkin('USP-S Printstream', 0.1882775545885)?.marketHashName, 'USP-S | Printstream (Field-Tested)');
    assert.equal(linkSkin('Desert Eagle Printstream', 0.081775918603)?.marketHashName, 'Desert Eagle | Printstream (Minimal Wear)');
  });

  it('no inventa un mercado para una skin desconocida', () => {
    assert.equal(linkSkin('P2000 Red Wing', 0.12), null);
  });

  it('un Talon sin Black Pearl no hereda la fase del #26', () => {
    assert.equal(linkSkin('★ Talon Knife | Doppler', 0.03), null);
  });

  it('una skin buscada usa el desgaste del float y la fase guardada', () => {
    const resolved = resolveSkinLink({
      name: '★ Talon Knife | Doppler #26',
      notes: 'Float 0.03. Paint 418.',
      quoteId: '★ Talon Knife | Doppler',
    });
    assert.equal(resolved?.link.marketHashName, '★ Talon Knife | Doppler (Factory New)');
    assert.equal(resolved?.link.paintIndex, 418);
    assert.equal(resolved?.link.rank, 26);
    const redline = resolveSkinLink({
      name: 'AK-47 | Redline',
      notes: 'Float 0.18.',
      quoteId: 'AK-47 | Redline (Minimal Wear)',
    });
    assert.equal(redline?.link.marketHashName, 'AK-47 | Redline (Field-Tested)');
    assert.equal(redline?.link.paintIndex, null);
    assert.equal(redline?.link.rank, null);
  });

  it('valora el puesto bajo con las ventas de rangos vecinos y deja fuera un puesto lejano', () => {
    const estimate = estimateSkin(talon, { floatValue: 0.00787745323, rank: 26 });
    assert.ok(estimate);
    assert.equal(estimate.usd, 3231.95);
    assert.equal(estimate.count, 3);
    assert.match(estimate.basis, /#26 del mundo/);
    assert.doesNotMatch(estimate.basis, /Puesto bajo/);
    assert.match(estimate.basis, /#20/);
    assert.match(estimate.basis, /#33/);
    assert.doesNotMatch(estimate.basis, /#70/);
  });

  it('en un arma normal usa la mediana de ventas sin pegatinas y con float cercano', () => {
    const sales: SkinSale[] = [
      { usd: 93.52, floatValue: 0.1604, lowRank: null, stickers: 5 },
      { usd: 88, floatValue: 0.1682, lowRank: null, stickers: 0 },
      { usd: 84, floatValue: 0.1754, lowRank: null, stickers: 0 },
      { usd: 80, floatValue: 0.1805, lowRank: null, stickers: 0 },
      { usd: 40, floatValue: 0.35, lowRank: null, stickers: 0 },
    ];
    const estimate = estimateSkin(sales, { floatValue: 0.15408782661, rank: null });
    assert.ok(estimate);
    assert.equal(estimate.usd, 84);
    assert.equal(estimate.count, 3);
  });

  it('si las ventas cercanas llevan pegatinas, usa esas y no unas limpias lejanas', () => {
    const sales: SkinSale[] = [
      { usd: 20, floatValue: 0.35, lowRank: null, stickers: 0 },
      { usd: 22, floatValue: 0.36, lowRank: null, stickers: 0 },
      { usd: 21, floatValue: 0.34, lowRank: null, stickers: 0 },
      { usd: 38.5, floatValue: 0.181, lowRank: null, stickers: 4 },
      { usd: 40, floatValue: 0.186, lowRank: null, stickers: 4 },
    ];
    const estimate = estimateSkin(sales, { floatValue: 0.18, rank: null });
    assert.ok(estimate);
    assert.equal(estimate.usd, 39.25);
  });

  it('marca la subida de un día y no llama 24 h a un tramo corto', () => {
    const day = seriesMove([
      { at: '2026-10-25T10:00:00.000Z', eur: 100 },
      { at: '2026-10-26T12:00:00.000Z', eur: 110 },
    ]);
    assert.equal(day.changePct, 10);
    assert.equal(day.changeLabel, '24 h');
    const short = seriesMove([
      { at: '2026-10-26T10:00:00.000Z', eur: 80 },
      { at: '2026-10-26T12:00:00.000Z', eur: 76 },
    ]);
    assert.equal(short.changePct, -5);
    assert.equal(short.changeLabel, 'en las ventas');
    assert.equal(seriesMove([{ at: '2026-10-26T12:00:00.000Z', eur: 10 }]).changePct, null);
  });

  it('no da un precio si no hay dos ventas comparables', () => {
    assert.equal(estimateSkin([{ usd: 90, floatValue: 0.16, lowRank: null, stickers: 0 }], { floatValue: 0.15, rank: null }), null);
  });
});
