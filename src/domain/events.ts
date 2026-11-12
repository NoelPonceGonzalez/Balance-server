import { addDays } from './finance.js';

/** A partir de aquí una salida a bolsa es lo bastante grande como para mover el resto del mercado. */
export const MEGA_IPO_USD = 5_000_000_000;

export type IpoKind = 'upcoming' | 'filed' | 'priced';

export type IpoRow = {
  id: string;
  name: string;
  ticker: string;
  date: string;
  usd: number;
  kind: IpoKind;
};

export type AssetBook = {
  crypto: string[];
  listed: string[];
};

export type IpoNotice = {
  key: string;
  title: string;
  body: string;
};

type CalendarRow = {
  dealID?: string | null;
  proposedTickerSymbol?: string | null;
  companyName?: string | null;
  expectedPriceDate?: string | null;
  pricedDate?: string | null;
  filedDate?: string | null;
  dollarValueOfSharesOffered?: string | null;
};

type CalendarPayload = {
  data?: {
    priced?: { rows?: CalendarRow[] | null };
    upcoming?: { upcomingTable?: { rows?: CalendarRow[] | null } };
    filed?: { rows?: CalendarRow[] | null };
  };
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function dollarsOf(value: string): number {
  const number = Number(value.replace(/[^0-9.]/g, ''));
  return Number.isFinite(number) ? number : 0;
}

export function usDate(value: string): string {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return '';
  return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}

export function companyName(value: string): string {
  const cut = value.split(',')[0].replace(/\b(inc|ltd|ag|corp|pbc|plc|co|company)\b\.?/gi, '').replace(/\s+/g, ' ').trim();
  if (!cut) return value.trim();
  return cut.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (letter) => letter.toUpperCase());
}

export function isSpac(name: string): boolean {
  return /acquisition|capital corp|blank check|holdings corp/i.test(name);
}

function rowOf(raw: CalendarRow, kind: IpoKind, date: string): IpoRow | null {
  const id = text(raw.dealID);
  const rawName = text(raw.companyName);
  if (isSpac(rawName)) return null;
  const name = companyName(rawName);
  if (!id || !name || !date) return null;
  return {
    id,
    name,
    ticker: text(raw.proposedTickerSymbol).toUpperCase(),
    date,
    usd: dollarsOf(text(raw.dollarValueOfSharesOffered)),
    kind,
  };
}

export function readIpoCalendar(payload: unknown): IpoRow[] {
  const data = (payload || {}) as CalendarPayload;
  const upcoming = data.data?.upcoming?.upcomingTable?.rows || [];
  const filed = data.data?.filed?.rows || [];
  const priced = data.data?.priced?.rows || [];
  return [
    ...upcoming.flatMap((row) => {
      const item = rowOf(row, 'upcoming', usDate(text(row.expectedPriceDate)));
      return item ? [item] : [];
    }),
    ...filed.flatMap((row) => {
      const item = rowOf(row, 'filed', usDate(text(row.filedDate)));
      return item ? [item] : [];
    }),
    ...priced.flatMap((row) => {
      const item = rowOf(row, 'priced', usDate(text(row.pricedDate)));
      return item ? [item] : [];
    }),
  ];
}

function usdText(value: number): string {
  if (value >= 1_000_000_000) {
    const billions = value / 1_000_000_000;
    const digits = billions >= 10 ? 0 : 1;
    const shown = new Intl.NumberFormat('es-ES', { maximumFractionDigits: digits }).format(billions);
    return `${shown} mil millones de dólares`;
  }
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function dayLabel(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return day;
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, date)));
}

function owns(book: AssetBook): string {
  const names = [...book.crypto, ...book.listed].slice(0, 3);
  if (!names.length) return '';
  if (names.length === 1) return `Tienes ${names[0]}.`;
  return `Tienes ${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}.`;
}

function touches(book: AssetBook, row: IpoRow): boolean {
  if (!(row.usd >= MEGA_IPO_USD) || isSpac(row.name)) return false;
  return book.crypto.length > 0 || book.listed.length > 0;
}

export function ipoNotices(rows: IpoRow[], book: AssetBook, today: string): IpoNotice[] {
  if (!book.crypto.length && !book.listed.length) return [];
  const horizon = addDays(today, 14);
  const filedSince = addDays(today, -2);
  const pricedSince = addDays(today, -1);
  const scheduled = new Set(rows.filter((row) => row.kind === 'upcoming').map((row) => row.id));
  const notices: IpoNotice[] = [];
  for (const row of rows) {
    if (!touches(book, row)) continue;
    const size = usdText(row.usd);
    const held = owns(book);
    if (row.kind === 'upcoming' && row.date >= today && row.date <= horizon) {
      const todayListing = row.date === today;
      notices.push({
        key: todayListing ? `event:ipo:${row.id}:hoy` : `event:ipo:${row.id}`,
        title: todayListing ? `Hoy sale a bolsa ${row.name}` : `${row.name} sale a bolsa el ${dayLabel(row.date)}`,
        body: `${held} Colocan unos ${size}. Una salida así de grande puede sacar dinero de otros activos unos días antes y el mismo día.`,
      });
    }
    if (row.kind === 'filed' && row.date >= filedSince && row.date <= today && !scheduled.has(row.id)) {
      notices.push({
        key: `event:filed:${row.id}`,
        title: `${row.name} ha pedido salir a bolsa`,
        body: `${held} Han registrado una colocación de unos ${size} y todavía no hay fecha. Cuando una salida es así de grande, el estreno puede mover lo que tienes.`,
      });
    }
    if (row.kind === 'priced' && row.date >= pricedSince && row.date <= today) {
      notices.push({
        key: `event:priced:${row.id}`,
        title: `${row.name} ya tiene precio de salida`,
        body: `${held} Han fijado unos ${size}. El estreno puede mover lo que tienes el día que empiece a cotizar.`,
      });
    }
  }
  return notices.slice(0, 4);
}

export function moveWorthTelling(assetClass: string, changePct: number | null): 'up' | 'down' | null {
  if (changePct == null || !Number.isFinite(changePct)) return null;
  const bar = assetClass === 'crypto' ? 5 : assetClass === 'stock' || assetClass === 'etf' ? 4 : null;
  if (bar == null || Math.abs(changePct) < bar) return null;
  return changePct > 0 ? 'up' : 'down';
}
