import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { companyName, dollarsOf, ipoNotices, isSpac, moveWorthTelling, readIpoCalendar, usDate, type AssetBook, type IpoRow } from './events.ts';

const crypto: AssetBook = { crypto: ['Bitcoin', 'Ethereum'], listed: [] };
const empty: AssetBook = { crypto: [], listed: [] };

function ipo(extra: Partial<IpoRow> = {}): IpoRow {
  return {
    id: 'ant',
    name: 'Anthropic',
    ticker: 'ANT',
    date: '2026-11-19',
    usd: 74_000_000_000,
    kind: 'upcoming',
    ...extra,
  };
}

describe('salidas a bolsa que tocan lo que tienes', () => {
  it('avisa de una colocación grande si tienes cripto', () => {
    const [notice] = ipoNotices([ipo()], crypto, '2026-11-12');
    assert.equal(notice.key, 'event:ipo:ant');
    assert.match(notice.title, /Anthropic sale a bolsa el 19 nov/);
    assert.match(notice.body, /Bitcoin y Ethereum/);
    assert.match(notice.body, /74 mil millones/);
  });

  it('el mismo día dice que sale hoy', () => {
    const [notice] = ipoNotices([ipo({ date: '2026-11-19' })], crypto, '2026-11-19');
    assert.equal(notice.key, 'event:ipo:ant:hoy');
    assert.match(notice.title, /Hoy sale a bolsa/);
  });

  it('ignora una salida pequeña y a quien no tiene activos de mercado', () => {
    assert.equal(ipoNotices([ipo({ usd: 200_000_000 })], crypto, '2026-11-12').length, 0);
    assert.equal(ipoNotices([ipo()], empty, '2026-11-12').length, 0);
  });

  it('avisa de un registro nuevo y no de un SPAC', () => {
    const filed = ipo({ id: 'new', kind: 'filed', date: '2026-11-11', name: 'Northwind' });
    assert.equal(ipoNotices([filed], crypto, '2026-11-12')[0].key, 'event:filed:new');
    assert.equal(ipoNotices([ipo({ id: 'spac', kind: 'filed', date: '2026-11-11', name: 'Churchill Capital Corp' })], crypto, '2026-11-12').length, 0);
  });

  it('lee el calendario y limpia el nombre', () => {
    const rows = readIpoCalendar({
      data: {
        upcoming: { upcomingTable: { rows: [{ dealID: '1', companyName: 'ANTHROPIC, PBC', proposedTickerSymbol: 'ANT', expectedPriceDate: '11/19/2026', dollarValueOfSharesOffered: '$74,002,500,000' }] } },
        filed: { rows: [] },
        priced: { rows: [] },
      },
    });
    assert.equal(rows[0].name, 'Anthropic');
    assert.equal(rows[0].date, '2026-11-19');
    assert.equal(rows[0].usd, 74002500000);
    assert.equal(companyName('WINDWARD BIO GROUP AG'), 'Windward Bio Group');
    assert.equal(usDate('11/2/2026'), '2026-11-02');
    assert.equal(dollarsOf('$90,988,000'), 90988000);
    assert.equal(isSpac('Churchill Capital Corp XIV'), true);
  });
});

describe('movimiento de un activo tuyo', () => {
  it('avisa a partir del 5 % en cripto y del 4 % en bolsa', () => {
    assert.equal(moveWorthTelling('crypto', -5.2), 'down');
    assert.equal(moveWorthTelling('crypto', 3), null);
    assert.equal(moveWorthTelling('stock', 4), 'up');
    assert.equal(moveWorthTelling('personal_good', 20), null);
  });
});
