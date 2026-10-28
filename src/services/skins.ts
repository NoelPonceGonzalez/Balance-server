import { estimateSkin, isSkinMarketName, linkSkin, phasesFor, rankFromFloat, resolveSkinLink, skinBaseName, wearOf, type SkinSale } from '../domain/skins.js';
import { roundMoney } from '../domain/finance.js';
import { Holding } from '../models/Holding.js';
import { recordSnapshot } from './ledger.js';

const GAP_MS = 30 * 60_000;
let lastRunAt = 0;
let usdPerEurCache: { at: number; rate: number } | null = null;

async function usdPerEur(): Promise<number | null> {
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
      const sale = row as { price?: number; sold_at?: string; created_at?: string; item?: { float_value?: number; stickers?: unknown[] } };
      const usd = typeof sale.price === 'number' ? sale.price / 100 : null;
      const at = sale.sold_at || sale.created_at || '';
      if (usd == null || !(usd > 0) || !at) return [];
      const floatValue = sale.item?.float_value;
      return [{
        at,
        eur: roundMoney(usd / rate),
        floatValue: typeof floatValue === 'number' && Number.isFinite(floatValue) ? floatValue : null,
        stickers: Array.isArray(sale.item?.stickers) ? sale.item.stickers.length : 0,
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

function steamIcon(icon: string | undefined): string | null {
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

const searchCache = new Map<string, { at: number; hits: SkinHit[] }>();

export async function searchSkins(query: string): Promise<SkinHit[]> {
  const key = query.trim().toLowerCase();
  if (key.length < 2) return [];
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.hits;
  const response = await fetch(`https://steamcommunity.com/market/search/render/?query=${encodeURIComponent(query.trim())}&appid=730&norender=1&count=20`, {
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Steam ha respondido ${response.status}.`);
  const data = (await response.json()) as { results?: { hash_name?: string; asset_description?: { icon_url?: string } }[] };
  const grouped = new Map<string, SkinHit>();
  for (const row of data.results || []) {
    const hash = skinBaseName(String(row.hash_name || ''));
    if (!isSkinMarketName(hash)) continue;
    const wear = String(row.hash_name || '').match(/\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/i)?.[1] || '';
    const image = steamIcon(row.asset_description?.icon_url);
    const current = grouped.get(hash);
    if (current) {
      if (wear && !current.wears.includes(wear)) current.wears.push(wear);
      if (!current.image && image) current.image = image;
    } else {
      grouped.set(hash, { name: hash, image, wears: wear ? [wear] : [], phases: phasesFor(hash) });
    }
  }
  const hits = [...grouped.values()].slice(0, 8);
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
