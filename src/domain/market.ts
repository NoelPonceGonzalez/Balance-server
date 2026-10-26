/** Decisiones de cotización, sin red ni base de datos. */

export type QuoteSource = 'coingecko' | 'yahoo';

export interface LiveQuote {
  source: QuoteSource;
  externalId: string;
  symbol: string;
  name: string;
  image: string | null;
  /** Precio en la moneda de la cotización. */
  nativePrice: number;
  nativeCurrency: string;
  priceEur: number;
  /** Porcentaje. Positivo es subida. */
  changePct: number | null;
  /** Etiqueta de la variación: 24 h en cripto, sesión en bolsa. */
  changeLabel: '24 h' | 'sesión';
  sparkline: number[];
}

export interface Candidate {
  source: QuoteSource;
  externalId: string;
  symbol: string;
  name: string;
  image: string | null;
  rank: number | null;
  kind?: 'crypto' | 'etf' | 'stock';
}

function searchWords(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TOKENIZED = /tokeniz|ondo|robinhood|\bbacked\b|defi/;

/** Deja arriba el valor que encaja y aparta copias y monedas que solo se parecen. */
export function rankCandidates(query: string, items: Candidate[]): Candidate[] {
  const words = searchWords(query);
  const needle = words.replace(/ /g, '');
  if (needle.length < 2) return [];
  const phrase = words.includes(' ');
  const scored = items.map((item) => {
    const symbol = searchWords(item.symbol).replace(/ /g, '');
    const name = searchWords(item.name);
    const nameCompact = name.replace(/ /g, '');
    let score = 0;
    if (symbol === needle || name === words) score += 120;
    else if (name.startsWith(words)) score += 90;
    else if (phrase && name.includes(words)) score += 70;
    else if (needle.length >= 3 && (symbol.startsWith(needle) || nameCompact.startsWith(needle))) score += 60;
    else if (!phrase && symbol.startsWith(needle)) score += 60;
    else if (needle.length >= 3 && (symbol.includes(needle) || nameCompact.includes(needle))) score += 35;
    if (score === 0) return { item, score };
    if (item.source === 'coingecko') {
      if (item.rank != null && item.rank <= 50) score += 24;
      else if (item.rank != null && item.rank <= 200) score += 10;
      else if (item.rank == null) score -= 30;
      if (TOKENIZED.test(name)) score -= 40;
      if (phrase) score -= 15;
    } else {
      score += 18;
      if (item.kind === 'etf') score += 6;
    }
    return { item, score };
  });
  return scored
    .filter((row) => row.score >= 50)
    .sort((a, b) => b.score - a.score || (a.item.rank ?? 9999) - (b.item.rank ?? 9999) || a.item.name.localeCompare(b.item.name))
    .slice(0, 12)
    .map((row) => row.item);
}

export interface AppliedPrice {
  unitMarketValue: number;
  eurPerUnit: number | null;
}

export function quoteKey(source: QuoteSource, externalId: string): string {
  return `${source}:${externalId}`;
}

export function downsample(values: number[], max = 42): number[] {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length <= max) return clean;
  const out: number[] = [];
  for (let i = 0; i < max; i += 1) {
    const start = Math.floor((i * clean.length) / max);
    const end = Math.max(start + 1, Math.floor(((i + 1) * clean.length) / max));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += clean[j];
    out.push(sum / (end - start));
  }
  return out;
}

/**
 * Euros por 1 unidad de moneda extranjera.
 * `foreignPerEur` es el mapa de Frankfurter: 1 EUR = X moneda.
 */
export function eurPerForeignUnit(currency: string, foreignPerEur: Record<string, number>): number | null {
  const code = currency.trim().toUpperCase();
  if (code === 'EUR') return 1;
  const foreign = foreignPerEur[code];
  if (!(foreign > 0) || !Number.isFinite(foreign)) return null;
  return 1 / foreign;
}

export function priceInEur(nativePrice: number, nativeCurrency: string, foreignPerEur: Record<string, number>): number | null {
  if (!Number.isFinite(nativePrice) || nativePrice < 0) return null;
  const per = eurPerForeignUnit(nativeCurrency, foreignPerEur);
  if (per == null) return null;
  return nativePrice * per;
}

/** Convierte la cotización a la moneda en la que está guardado el activo. */
export function priceForHolding(
  quote: Pick<LiveQuote, 'nativePrice' | 'nativeCurrency' | 'priceEur'>,
  holdingCurrency: string,
  foreignPerEur: Record<string, number>,
): AppliedPrice | null {
  const currency = holdingCurrency.trim().toUpperCase();
  if (!(quote.priceEur >= 0) || !Number.isFinite(quote.priceEur)) return null;
  if (currency === 'EUR') return { unitMarketValue: quote.priceEur, eurPerUnit: null };
  if (currency === quote.nativeCurrency.trim().toUpperCase() && quote.nativePrice >= 0) {
    const per = quote.nativePrice > 0 ? quote.priceEur / quote.nativePrice : null;
    if (!(per && per > 0)) return null;
    return { unitMarketValue: quote.nativePrice, eurPerUnit: per };
  }
  const per = eurPerForeignUnit(currency, foreignPerEur);
  if (!(per && per > 0)) return null;
  return { unitMarketValue: quote.priceEur / per, eurPerUnit: per };
}

function chooseUnique(pool: Candidate[]): Candidate | null {
  if (pool.length === 1) return pool[0];
  if (!pool.length) return null;
  const ranked = pool
    .filter((item) => item.rank != null && item.rank > 0)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  if (!ranked.length) return null;
  const best = ranked[0];
  const second = ranked[1];
  if (!second) return best;
  if ((best.rank ?? 0) <= 25 && (second.rank ?? 0) - (best.rank ?? 0) >= 50) return best;
  return null;
}

/**
 * Enlaza solo cuando el símbolo o el nombre coinciden y no hay otra cotización igual de creíble.
 * Varias bolsas para el mismo ETF se quedan sin enlace automático.
 */
export function pickAutoLink(symbol: string, candidates: Candidate[]): Candidate | null {
  const wanted = symbol.trim().toUpperCase();
  if (!wanted) return null;
  const exact = candidates.filter((item) => item.symbol.trim().toUpperCase() === wanted);
  const pool = exact.length
    ? exact
    : candidates.filter((item) => item.symbol.trim().toUpperCase().split('.')[0] === wanted);
  const bySymbol = chooseUnique(pool);
  if (bySymbol) return bySymbol;
  const named = candidates.filter((item) => item.name.trim().toLowerCase() === symbol.trim().toLowerCase());
  return chooseUnique(named);
}

/** Pasa un importe en euros a participaciones. */
export function sharesForLump(lumpEur: number, unitPrice: number): number | null {
  if (!(lumpEur > 0) || !(unitPrice > 0) || !Number.isFinite(lumpEur) || !Number.isFinite(unitPrice)) return null;
  return Math.round((lumpEur / unitPrice) * 1e8) / 1e8;
}

export type PriceGrain = 'minute' | 'hour' | 'day';

/** Elige el precio más cercano a la hora de la compra y dice si es de minuto, hora o día. */
export function closestQuote(
  points: { at: number; price: number }[],
  targetMs: number,
): { price: number; at: number; grain: PriceGrain } | null {
  const clean = points.filter((point) => point.price > 0 && Number.isFinite(point.price) && Number.isFinite(point.at));
  if (!clean.length || !Number.isFinite(targetMs)) return null;
  let best = clean[0];
  let gap = Math.abs(best.at - targetMs);
  for (const point of clean) {
    const next = Math.abs(point.at - targetMs);
    if (next < gap) {
      best = point;
      gap = next;
    }
  }
  const sorted = [...clean].sort((a, b) => a.at - b.at);
  let step = Number.POSITIVE_INFINITY;
  for (let index = 1; index < sorted.length; index += 1) step = Math.min(step, sorted[index].at - sorted[index - 1].at);
  const grain: PriceGrain = step <= 15 * 60_000 ? 'minute' : step <= 3 * 3_600_000 ? 'hour' : 'day';
  return { price: best.price, at: best.at, grain };
}

/** Interpreta `YYYY-MM-DDTHH:mm` como hora de Madrid. */
export function instantInMadrid(local: string, now = Date.now()): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error('La fecha y la hora no son válidas.');
  const [date, time] = local.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let utc = wanted;
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Madrid',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(utc));
    const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    utc -= Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute')) - wanted;
  }
  const result = new Date(utc);
  if (Number.isNaN(result.getTime())) throw new Error('La fecha y la hora no son válidas.');
  if (result.getTime() > now + 60_000) throw new Error('Esa hora todavía no ha llegado.');
  return result;
}

export function priceGrainNote(grain: PriceGrain): string {
  if (grain === 'minute') return 'Precio de ese minuto.';
  if (grain === 'hour') return 'De ese minuto no hay precio. Uso la hora más cercana.';
  return 'De esa hora no hay precio. Uso el del día.';
}

export interface BandAlert {
  thresholdPct: number;
  armed: boolean;
}

/** Avisa una vez al cruzar el umbral y se rearma cuando el movimiento vuelve a ser menor. */
export function evaluateBand(changePct: number | null, alert: BandAlert): { fire: 'up' | 'down' | null; armed: boolean } {
  if (changePct == null || !Number.isFinite(changePct) || !(alert.thresholdPct > 0)) {
    return { fire: null, armed: alert.armed };
  }
  if (Math.abs(changePct) < alert.thresholdPct) return { fire: null, armed: true };
  if (!alert.armed) return { fire: null, armed: false };
  return { fire: changePct > 0 ? 'up' : 'down', armed: false };
}

export interface LevelAlert {
  direction: 'above' | 'below';
  target: number;
  armed: boolean;
}

export function evaluateLevel(priceEur: number | null, alert: LevelAlert): { fire: boolean; armed: boolean } {
  if (priceEur == null || !Number.isFinite(priceEur) || !(alert.target > 0)) return { fire: false, armed: alert.armed };
  const outside = alert.direction === 'above' ? priceEur >= alert.target : priceEur <= alert.target;
  if (!outside) return { fire: false, armed: true };
  if (!alert.armed) return { fire: false, armed: false };
  return { fire: true, armed: false };
}

export function isQuoteId(source: QuoteSource, externalId: string): boolean {
  if (source === 'coingecko') return /^[a-z0-9-]{1,80}$/.test(externalId);
  return /^[A-Za-z0-9.^=-]{1,20}$/.test(externalId);
}

export function sourceLabel(source: QuoteSource): string {
  return source === 'coingecko' ? 'CoinGecko' : 'Yahoo Finance';
}
