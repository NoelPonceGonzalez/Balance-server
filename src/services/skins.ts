import { estimateSkin, isSkinMarketName, linkSkin, phasesFor, rankFromFloat, resolveSkinLink, skinBaseName, wearOf, type SkinSale } from '../domain/skins.js';
import { roundMoney } from '../domain/finance.js';
import { Holding } from '../models/Holding.js';
import { recordSnapshot } from './ledger.js';
import { skinportAsks } from './skinport-feed.js';

const GAP_MS = 30 * 60_000;
let lastRunAt = 0;
let usdPerEurCache: { at: number; rate: number } | null = null;

export async function usdPerEur(): Promise<number | null> {
  if (usdPerEurCache && Date.now() - usdPerEurCache.at < 10 * 60_000) return usdPerEurCache.rate;
  try {
    const response = await fetch('https://api.frankfurter.app/latest?from=EUR', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return usdPerEurCache?.rate ?? null;
    const data = (await response.json()) as { rates?: { USD?: number } };
    const rate = data.rates?.USD;
    if (!(rate && rate > 0)) return usdPerEurCache?.rate ?? null;
    usdPerEurCache = { at: Date.now(), rate };
    return rate;
  } catch {
    return usdPerEurCache?.rate ?? null;
  }
}

async function fetchSales(marketHashName: string, paintIndex: number | null): Promise<{ sales: SkinSale[]; icon: string | null }> {
  const query = paintIndex == null ? '' : `?paint_index=${paintIndex}`;
  const response = await fetch(`https://csfloat.com/api/v1/history/${encodeURIComponent(marketHashName)}/sales${query}`, {
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`CSFloat ha respondido ${response.status}.`);
  const data = (await response.json()) as unknown;
  if (!Array.isArray(data)) return { sales: [], icon: null };
  let icon: string | null = null;
  const sales = data.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const sale = row as { price?: number; item?: { float_value?: number; low_rank?: number; stickers?: unknown[]; icon_url?: string } };
    const picture = steamIcon(sale.item?.icon_url);
    if (!icon && picture) icon = picture;
    const usd = typeof sale.price === 'number' ? sale.price / 100 : null;
    const floatValue = sale.item?.float_value;
    if (usd == null || !(usd > 0) || floatValue == null || !Number.isFinite(floatValue)) return [];
    const rank = sale.item?.low_rank;
    return [{
      usd,
      floatValue,
      lowRank: typeof rank === 'number' && rank > 0 ? rank : null,
      stickers: Array.isArray(sale.item?.stickers) ? sale.item.stickers.length : 0,
    }];
  });
  return { sales, icon };
}

export interface PricedSale {
  at: string;
  eur: number;
  floatValue: number | null;
  stickers: number;
  icon: string | null;
  id: string | null;
}

const historyCache = new Map<string, { at: number; sales: PricedSale[] }>();

export async function pricedHistory(marketHashName: string, paintIndex: number | null): Promise<PricedSale[]> {
  const key = `${marketHashName}|${paintIndex ?? ''}`;
  const cached = historyCache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.sales;
  const rate = await usdPerEur();
  if (!rate) return cached?.sales ?? [];
  try {
    const query = paintIndex == null ? '' : `?paint_index=${paintIndex}`;
    const response = await fetch(`https://csfloat.com/api/v1/history/${encodeURIComponent(marketHashName)}/sales${query}`, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      if (!cached) historyCache.set(key, { at: Date.now() - 8 * 60_000, sales: [] });
      return cached?.sales ?? [];
    }
    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) return cached?.sales ?? [];
    const sales = data.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const sale = row as { id?: string; price?: number; sold_at?: string; created_at?: string; item?: { float_value?: number; stickers?: unknown[]; icon_url?: string } };
      const usd = typeof sale.price === 'number' ? sale.price / 100 : null;
      const at = sale.sold_at || sale.created_at || '';
      if (usd == null || !(usd > 0) || !at) return [];
      const floatValue = sale.item?.float_value;
      return [{
        at,
        eur: roundMoney(usd / rate),
        floatValue: typeof floatValue === 'number' && Number.isFinite(floatValue) ? floatValue : null,
        stickers: Array.isArray(sale.item?.stickers) ? sale.item.stickers.length : 0,
        icon: steamIcon(sale.item?.icon_url),
        id: typeof sale.id === 'string' ? sale.id : null,
      }];
    });
    historyCache.set(key, { at: Date.now(), sales });
    return sales;
  } catch {
    return cached?.sales ?? [];
  }
}

/** Lo que valía una skin cerca de una hora, con ventas reales de alrededor. */
export async function worthNear(marketName: string, floatValue: number, paintIndex: number | null, at: Date): Promise<{ eur: number; note: string } | null> {
  const name = skinBaseName(marketName);
  if (!isSkinMarketName(name) || !(floatValue >= 0 && floatValue <= 1)) return null;
  const sales = await pricedHistory(name, paintIndex);
  const target = at.getTime();
  if (!Number.isFinite(target) || !sales.length) return null;
  const windows = [3, 14, 90];
  for (const days of windows) {
    const span = days * 86_400_000;
    const width = days === 90 ? 1 : floatValue < 0.07 ? 0.01 : floatValue < 0.15 ? 0.02 : 0.05;
    const near = sales.filter((sale) => {
      const when = Date.parse(sale.at);
      if (!Number.isFinite(when) || Math.abs(when - target) > span) return false;
      if (sale.floatValue == null) return true;
      return Math.abs(sale.floatValue - floatValue) <= width;
    });
    const eur = medianEur(near);
    if (eur != null && near.length >= 2) {
      return { eur, note: `Mediana de ${near.length} ventas cercanas a esa hora.` };
    }
  }
  return null;
}

export function medianEur(sales: PricedSale[]): number | null {
  const clean = sales.filter((sale) => sale.stickers === 0).map((sale) => sale.eur);
  const values = clean.length >= 2 ? clean : sales.map((sale) => sale.eur);
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return roundMoney(value);
}

export interface OpenAsk {
  market: 'CSFloat' | 'Skinport';
  id: string;
  eur: number;
  url: string;
  floatValue: number | null;
  paintSeed: number | null;
  referenceEur: number | null;
  image: string | null;
}

let csfloatListingsBlockedUntil = 0;

async function csfloatAsks(name: string, key: string | null, maxEur: number | null): Promise<OpenAsk[] | 'blocked' | 'unknown'> {
  if (!key) return 'blocked';
  const params = new URLSearchParams({
    limit: '50',
    sort_by: 'lowest_price',
    type: 'buy_now',
    market_hash_name: name,
  });
  const rate = await usdPerEur();
  if (maxEur != null && maxEur > 0 && rate) params.set('max_price', String(Math.ceil(maxEur * rate * 100)));
  const response = await fetch(`https://csfloat.com/api/v1/listings?${params}`, {
    headers: {
      accept: 'application/json',
      authorization: key,
      'user-agent': 'Mozilla/5.0',
      origin: 'https://csfloat.com',
      referer: 'https://csfloat.com/',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (response.status === 401 || response.status === 403) return 'blocked';
  if (!response.ok) return 'unknown';
  const data = (await response.json()) as { data?: unknown };
  const rows = Array.isArray(data.data) ? data.data : [];
  if (!rate) return 'unknown';
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const listing = row as { id?: string; price?: number; reference?: { predicted_price?: number }; item?: { float_value?: number; paint_seed?: number; icon_url?: string; market_hash_name?: string } };
    if (listing.item?.market_hash_name && listing.item.market_hash_name !== name) return [];
    const usd = typeof listing.price === 'number' ? listing.price / 100 : null;
    const id = typeof listing.id === 'string' ? listing.id : '';
    const cents = typeof listing.price === 'number' ? Math.round(listing.price) : 0;
    if (usd == null || !(usd > 0) || !id || !(cents > 0)) return [];
    const floatValue = listing.item?.float_value;
    const paintSeed = listing.item?.paint_seed;
    const predicted = listing.reference?.predicted_price;
    const eur = roundMoney(usd / rate);
    return [{
      market: 'CSFloat' as const,
      id: `csfloat:${id}:${cents}`,
      eur,
      url: `https://csfloat.com/item/${id}`,
      floatValue: typeof floatValue === 'number' && Number.isFinite(floatValue) ? floatValue : null,
      paintSeed: typeof paintSeed === 'number' && Number.isFinite(paintSeed) ? paintSeed : null,
      referenceEur: typeof predicted === 'number' && predicted > 0 ? roundMoney(predicted / 100 / rate) : null,
      image: steamIcon(listing.item?.icon_url),
    }];
  });
}

/** Ofertas abiertas en CSFloat. `null` significa que no ha contestado: no se inventa otra tienda ni se olvida lo ya avisado. */
export async function openAsks(names: string[], key: string | null = null, maxEur = new Map<string, number>()): Promise<Map<string, OpenAsk[] | null>> {
  const out = new Map<string, OpenAsk[] | null>();
  const unique = [...new Set(names)];
  let blocked = !key || Date.now() < csfloatListingsBlockedUntil;
  if (!blocked) {
    for (const name of unique) {
      try {
        const asks = await csfloatAsks(name, key, maxEur.get(name) ?? null);
        if (asks === 'blocked') {
          blocked = true;
          if (!key) csfloatListingsBlockedUntil = Date.now() + 30 * 60_000;
          break;
        }
        if (asks === 'unknown') {
          out.set(name, null);
          continue;
        }
        out.set(name, asks);
      } catch (error) {
        console.error('ofertas', error instanceof Error ? error.message : error);
        out.set(name, null);
      }
    }
  }
  for (const name of unique) {
    const csfloat = out.get(name) ?? null;
    const cap = maxEur.get(name);
    const skinport = skinportAsks(name)?.filter((ask) => cap == null || ask.eur <= cap) ?? null;
    out.set(name, csfloat == null && !skinport?.length ? null : [...(csfloat || []), ...(skinport || [])]);
  }
  return out;
}

export function steamIcon(icon: string | undefined): string | null {
  if (!icon || icon.length > 500) return null;
  if (icon.startsWith('https://')) return icon;
  if (/[\s"'<>]/.test(icon)) return null;
  return `https://community.cloudflare.steamstatic.com/economy/image/${icon}`;
}

export interface SkinHit {
  name: string;
  image: string | null;
  wears: string[];
  phases: { id: string; label: string; paintIndex: number }[];
}

const SCHEMA_WEARS = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'] as const;
const SCHEMA_RANGES: [number, number][] = [[0, 0.07], [0.07, 0.15], [0.15, 0.38], [0.38, 0.45], [0.45, 1]];

interface SchemaPaint {
  name: string;
  folded: string;
  wears: { wear: string; cents: number; volume: number }[];
}

let schemaCache: { at: number; paints: SchemaPaint[] } | null = null;

function foldName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Precios de CSFloat por desgaste, en céntimos de dólar. No se mira el mercado de Steam. */
async function schemaPaints(): Promise<SchemaPaint[]> {
  if (schemaCache && Date.now() - schemaCache.at < 12 * 60 * 60_000) return schemaCache.paints;
  try {
    const response = await fetch('https://csfloat.com/api/v1/schema', {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return schemaCache?.paints ?? [];
    const data = (await response.json()) as {
      weapons?: Record<string, { name?: string; type?: string; paints?: Record<string, { name?: string; min?: number; max?: number; normal_prices?: number[]; normal_volume?: number[] }> }>;
    };
    const paints: SchemaPaint[] = [];
    for (const weapon of Object.values(data.weapons || {})) {
      if (!weapon?.name || !weapon.paints) continue;
      const star = weapon.type === 'Gloves' || weapon.type === 'Knives' ? '★ ' : '';
      for (const paint of Object.values(weapon.paints)) {
        if (!paint?.name) continue;
        const low = typeof paint.min === 'number' ? paint.min : 0;
        const high = typeof paint.max === 'number' ? paint.max : 1;
        const wears = SCHEMA_WEARS.flatMap((wear, index) => {
          if (!(SCHEMA_RANGES[index][0] < high && SCHEMA_RANGES[index][1] > low)) return [];
          const cents = paint.normal_prices?.[index];
          if (!(typeof cents === 'number' && cents > 0)) return [];
          const volume = paint.normal_volume?.[index];
          return [{ wear, cents, volume: typeof volume === 'number' && volume > 0 ? volume : 0 }];
        });
        if (!wears.length) continue;
        const name = `${star}${weapon.name} | ${paint.name}`;
        if (!isSkinMarketName(name)) continue;
        paints.push({ name, folded: foldName(name), wears });
      }
    }
    if (paints.length) schemaCache = { at: Date.now(), paints };
    return paints;
  } catch {
    return schemaCache?.paints ?? [];
  }
}

export interface CsfloatBoardRow {
  name: string;
  priceEur: number;
}

/** Las skins que más se mueven en CSFloat, con el precio de ese desgaste. */
export async function csfloatBoard(): Promise<CsfloatBoardRow[]> {
  const [paints, rate] = await Promise.all([schemaPaints(), usdPerEur()]);
  if (!rate) return [];
  const rows = paints.flatMap((paint) => {
    const best = [...paint.wears].sort((a, b) => b.volume - a.volume)[0];
    if (!best) return [];
    return [{ name: `${paint.name} (${best.wear})`, priceEur: roundMoney(best.cents / 100 / rate), volume: best.volume }];
  });
  return rows.sort((a, b) => b.volume - a.volume).slice(0, 8).map(({ name, priceEur }) => ({ name, priceEur }));
}

/** Precio de CSFloat para cada desgaste de una skin. Vacío si el catálogo no la tiene. */
export async function csfloatWearPrices(base: string): Promise<{ wear: string; priceEur: number }[]> {
  const wanted = foldName(skinBaseName(base));
  if (!wanted) return [];
  const [paints, rate] = await Promise.all([schemaPaints(), usdPerEur()]);
  if (!rate) return [];
  const paint = paints.find((row) => row.folded === wanted);
  if (!paint) return [];
  return paint.wears.map((row) => ({ wear: row.wear, priceEur: roundMoney(row.cents / 100 / rate) }));
}

const searchCache = new Map<string, { at: number; hits: SkinHit[] }>();

export async function searchSkins(query: string): Promise<SkinHit[]> {
  const key = query.trim().toLowerCase();
  if (key.length < 2) return [];
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.hits;
  const words = foldName(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const paints = await schemaPaints();
  const compact = words.join('');
  const hits = paints
    .filter((paint) => words.every((word) => paint.folded.includes(word)) || paint.folded.replace(/ /g, '').includes(compact))
    .slice(0, 8)
    .map((paint) => ({
      name: paint.name,
      image: null,
      wears: paint.wears.map((row) => row.wear),
      phases: phasesFor(paint.name),
    }));
  searchCache.set(key, { at: Date.now(), hits });
  return hits;
}

export async function rankForSkin(input: { label: string; marketName: string; floatValue: number; paintIndex: number | null }): Promise<number | null> {
  const catalog = linkSkin(input.label, input.floatValue) || linkSkin(input.marketName, input.floatValue);
  let marketHashName = catalog?.marketHashName || '';
  let paintIndex = catalog?.paintIndex ?? input.paintIndex;
  const base = skinBaseName(input.marketName || input.label);
  if (!marketHashName && isSkinMarketName(base)) {
    const wear = wearOf(input.floatValue);
    if (!wear || !/doppler|case hardened|fade/i.test(base)) return null;
    marketHashName = `${base} (${wear})`;
  }
  if (!marketHashName) return null;
  if (!/doppler|case hardened|fade/i.test(`${marketHashName} ${input.label} ${input.marketName}`) && paintIndex == null) return null;
  const pack = await fetchSales(marketHashName, paintIndex);
  return rankFromFloat(pack.sales, input.floatValue);
}

export async function refreshSkinHoldings(holdingId?: string): Promise<void> {
  const query: { assetClass: 'personal_good'; quantity: { $gt: number }; _id?: string } = {
    assetClass: 'personal_good',
    quantity: { $gt: 0 },
  };
  if (holdingId) query._id = holdingId;
  const holdings = await Holding.find(query);
  const linked = holdings.flatMap((holding) => {
    const resolved = resolveSkinLink({ name: holding.name, notes: holding.notes, quoteId: holding.quoteId });
    return resolved ? [{ holding, parsed: { value: resolved.floatValue, text: resolved.text }, link: resolved.link }] : [];
  });
  if (!linked.length) return;
  const rate = await usdPerEur();
  if (!rate) return;
  const cache = new Map<string, { sales: SkinSale[]; icon: string | null } | null>();
  const users = new Set<string>();
  for (const row of linked) {
    const key = `${row.link.marketHashName}|${row.link.paintIndex ?? ''}`;
    if (!cache.has(key)) {
      try {
        cache.set(key, await fetchSales(row.link.marketHashName, row.link.paintIndex));
      } catch (error) {
        cache.set(key, null);
        console.error('skins', error instanceof Error ? error.message : error);
      }
    }
    const pack = cache.get(key);
    if (!pack) continue;
    if (pack.icon) row.holding.quoteImage = pack.icon;
    const estimate = estimateSkin(pack.sales, { floatValue: row.parsed.value, rank: row.link.rank });
    if (!estimate) {
      if (pack.icon) await row.holding.save();
      continue;
    }
    const eur = roundMoney(estimate.usd / rate);
    if (!(eur > 0)) continue;
    const paintNote = row.link.paintIndex != null ? ` Paint ${row.link.paintIndex}.` : '';
    const notes = `Float ${row.parsed.text}.${paintNote} ${estimate.basis}.`;
    const previous = row.holding.unitMarketValue;
    const moved = previous == null || Math.abs(previous - eur) >= 0.01;
    row.holding.unitMarketValue = eur;
    row.holding.valuedAt = new Date();
    row.holding.priceSource = 'market';
    row.holding.followMarket = true;
    row.holding.quoteSource = 'csfloat';
    row.holding.quoteId = skinBaseName(row.link.marketHashName);
    row.holding.quoteKey = null;
    row.holding.notes = notes;
    await row.holding.save();
    if (moved) users.add(String(row.holding.userId));
  }
  for (const userId of users) await recordSnapshot(userId);
}

export function scheduleSkinRefresh(): void {
  void refreshSkinsIfDue().catch((error) => {
    console.error('skins', error);
  });
}

async function refreshSkinsIfDue(): Promise<void> {
  const missingImage = await Holding.exists({
    assetClass: 'personal_good',
    quantity: { $gt: 0 },
    $or: [{ quoteImage: null }, { quoteImage: '' }],
  });
  if (!missingImage && Date.now() - lastRunAt < GAP_MS) return;
  lastRunAt = Date.now();
  await refreshSkinHoldings();
}
