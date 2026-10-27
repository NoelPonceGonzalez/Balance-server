import { downsample } from './market.js';

/** Valor de una skin a partir de ventas reales de CSFloat, no de un precio genérico. */

export interface SkinSale {
  usd: number;
  floatValue: number;
  lowRank: number | null;
  stickers: number;
}

export interface SkinLink {
  marketHashName: string;
  paintIndex: number | null;
  rank: number | null;
}

export interface SkinEstimate {
  usd: number;
  count: number;
  basis: string;
}

interface Spec {
  match: RegExp;
  also?: RegExp;
  base: string;
  paintIndex?: number;
  fixedWear?: string;
  rankInName?: boolean;
}

const SPECS: Spec[] = [
  { match: /talon/i, also: /black pearl/i, base: '★ Talon Knife | Doppler', paintIndex: 417, fixedWear: 'Factory New', rankInName: true },
  { match: /b the monster/i, base: 'AK-47 | B the Monster' },
  { match: /vaporwave/i, base: 'M4A1-S | Vaporwave' },
  { match: /desert eagle|deagle/i, base: 'Desert Eagle | Printstream' },
  { match: /usp/i, base: 'USP-S | Printstream' },
  { match: /gold toof/i, base: 'Glock-18 | Gold Toof' },
];

export const SKIN_WEARS = [
  { wear: 'Factory New', label: 'Recién fabricada', from: 0, to: 0.07 },
  { wear: 'Minimal Wear', label: 'Casi nueva', from: 0.07, to: 0.15 },
  { wear: 'Field-Tested', label: 'Algo desgastada', from: 0.15, to: 0.38 },
  { wear: 'Well-Worn', label: 'Bastante desgastada', from: 0.38, to: 0.45 },
  { wear: 'Battle-Scarred', label: 'Veterana de guerra', from: 0.45, to: 1 },
] as const;

export function wearOf(floatValue: number): string | null {
  if (!(floatValue >= 0 && floatValue <= 1)) return null;
  if (floatValue < 0.07) return 'Factory New';
  if (floatValue < 0.15) return 'Minimal Wear';
  if (floatValue < 0.38) return 'Field-Tested';
  if (floatValue < 0.45) return 'Well-Worn';
  return 'Battle-Scarred';
}

export function floatFromNotes(notes: string | null | undefined): { value: number; text: string } | null {
  const match = (notes || '').match(/Float\s+(\d+\.\d+)/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!(value >= 0 && value <= 1)) return null;
  return { value, text: match[1] };
}

const WEAR_SUFFIX = /\s+\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/i;

export function skinBaseName(hashName: string): string {
  return hashName.replace(WEAR_SUFFIX, '').trim();
}

export function isSkinMarketName(name: string): boolean {
  if (!name || name.length > 100 || !name.includes(' | ')) return false;
  if (/^(Sticker|Sealed Graffiti|Patch|Music Kit|Charm|Graffiti)\b/i.test(name)) return false;
  return !/[\r\n<>"]/.test(name);
}

const DOPPLER_PHASES = [
  { id: 'ruby', label: 'Ruby', paintIndex: 415 },
  { id: 'sapphire', label: 'Sapphire', paintIndex: 416 },
  { id: 'black-pearl', label: 'Black Pearl', paintIndex: 417 },
  { id: 'phase-1', label: 'Phase 1', paintIndex: 418 },
  { id: 'phase-2', label: 'Phase 2', paintIndex: 419 },
  { id: 'phase-3', label: 'Phase 3', paintIndex: 420 },
  { id: 'phase-4', label: 'Phase 4', paintIndex: 421 },
];

const GAMMA_PHASES = [
  { id: 'emerald', label: 'Emerald', paintIndex: 568 },
  { id: 'phase-1', label: 'Phase 1', paintIndex: 569 },
  { id: 'phase-2', label: 'Phase 2', paintIndex: 570 },
  { id: 'phase-3', label: 'Phase 3', paintIndex: 571 },
  { id: 'phase-4', label: 'Phase 4', paintIndex: 572 },
];

export function phasesFor(base: string): { id: string; label: string; paintIndex: number }[] {
  if (/gamma doppler/i.test(base)) return GAMMA_PHASES;
  if (/doppler/i.test(base)) return DOPPLER_PHASES;
  return [];
}

export function paintFromNotes(notes: string | null | undefined): number | null {
  const match = (notes || '').match(/Paint\s+(\d{1,4})/i);
  if (!match) return null;
  const paint = Number(match[1]);
  const known = [...DOPPLER_PHASES, ...GAMMA_PHASES].some((phase) => phase.paintIndex === paint);
  return known ? paint : null;
}

export function resolveSkinLink(input: { name: string; notes?: string | null; quoteId?: string | null }): { floatValue: number; text: string; link: SkinLink } | null {
  const parsed = floatFromNotes(input.notes);
  if (!parsed) return null;
  const catalog = linkSkin(input.name, parsed.value);
  if (catalog) return { floatValue: parsed.value, text: parsed.text, link: catalog };
  const base = skinBaseName(input.quoteId || '');
  if (!isSkinMarketName(base)) return null;
  const wear = wearOf(parsed.value);
  if (!wear) return null;
  const rankMatch = /doppler|★|knife/i.test(base) ? input.name.match(/#\s*(\d{1,5})/) : null;
  const rank = rankMatch ? Number(rankMatch[1]) : null;
  const paint = /doppler/i.test(base) ? paintFromNotes(input.notes) : null;
  return {
    floatValue: parsed.value,
    text: parsed.text,
    link: {
      marketHashName: `${base} (${wear})`,
      paintIndex: paint,
      rank: rank != null && rank >= 1 ? rank : null,
    },
  };
}

export function linkSkin(name: string, floatValue: number | null): SkinLink | null {
  if (floatValue == null || !(floatValue >= 0 && floatValue <= 1)) return null;
  const spec = SPECS.find((item) => item.match.test(name) && (!item.also || item.also.test(name)));
  if (!spec) return null;
  const wear = spec.fixedWear || wearOf(floatValue);
  if (!wear) return null;
  const rankMatch = spec.rankInName ? name.match(/#\s*(\d{1,5})/) : null;
  const rank = rankMatch ? Number(rankMatch[1]) : null;
  return {
    marketHashName: `${spec.base} (${wear})`,
    paintIndex: spec.paintIndex ?? null,
    rank: rank != null && rank >= 1 ? rank : null,
  };
}

/** El puesto del mundo de ese float, si una venta es esa misma skin. Vale igual por encima de 500. */
export function rankFromFloat(sales: SkinSale[], floatValue: number): number | null {
  const ranked = sales.filter((sale) => sale.lowRank != null && sale.lowRank >= 1 && Number.isFinite(sale.floatValue));
  if (!ranked.length || !(floatValue >= 0 && floatValue <= 1)) return null;
  const nearest = [...ranked].sort((a, b) => Math.abs(a.floatValue - floatValue) - Math.abs(b.floatValue - floatValue));
  const same = nearest.filter((sale) => Math.abs(sale.floatValue - floatValue) <= 0.0000005);
  const ranks = new Set(same.map((sale) => sale.lowRank));
  if (same.length === 0 || ranks.size !== 1) return null;
  return same[0].lowRank;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fromRank(sales: SkinSale[], rank: number): SkinEstimate | null {
  const ranked = sales.filter((sale) => sale.lowRank != null && sale.usd > 0);
  if (ranked.length < 2) return null;
  const nearest = [...ranked].sort((a, b) => Math.abs((a.lowRank ?? 0) - rank) - Math.abs((b.lowRank ?? 0) - rank));
  const close = nearest.filter((sale) => Math.abs((sale.lowRank ?? 0) - rank) <= 15).slice(0, 5);
  const picked = close.length >= 2 ? close : nearest.slice(0, 3).filter((sale) => Math.abs((sale.lowRank ?? 0) - rank) <= 30);
  if (picked.length < 2) return null;
  const ranks = picked.map((sale) => sale.lowRank ?? rank);
  return {
    usd: median(picked.map((sale) => sale.usd)),
    count: picked.length,
    basis: `#${rank} del mundo. Mediana de ${picked.length} ventas CSFloat entre el #${Math.min(...ranks)} y el #${Math.max(...ranks)}`,
  };
}

function band(floatValue: number): number {
  if (floatValue < 0.07) return 0.004;
  if (floatValue < 0.15) return 0.012;
  if (floatValue < 0.38) return 0.03;
  return 0.05;
}

function nearest(pool: SkinSale[], floatValue: number): SkinSale[] {
  const width = band(floatValue);
  let picked = pool.filter((sale) => Math.abs(sale.floatValue - floatValue) <= width);
  if (picked.length < 2) picked = pool.filter((sale) => Math.abs(sale.floatValue - floatValue) <= width * 2);
  return [...picked].sort((a, b) => Math.abs(a.floatValue - floatValue) - Math.abs(b.floatValue - floatValue)).slice(0, 5);
}

function fromFloat(sales: SkinSale[], floatValue: number): SkinEstimate | null {
  const priced = sales.filter((sale) => sale.usd > 0 && Number.isFinite(sale.floatValue));
  const clean = nearest(priced.filter((sale) => sale.stickers === 0), floatValue);
  const picked = clean.length >= 2 ? clean : nearest(priced, floatValue);
  if (picked.length < 2) return null;
  return {
    usd: median(picked.map((sale) => sale.usd)),
    count: picked.length,
    basis: `Mediana de ${picked.length} ventas CSFloat con float cercano`,
  };
}

/** Subida o bajada entre la venta de hace un día y la última. Si el tramo es más corto, no lo llama 24 h. */
export function seriesMove(points: { at: string; eur: number }[]): { changePct: number | null; changeLabel: string; sparkline: number[] } {
  const ordered = points.filter((point) => point.eur > 0 && Number.isFinite(point.eur) && point.at).sort((a, b) => a.at.localeCompare(b.at));
  const sparkline = downsample(ordered.map((point) => point.eur));
  if (ordered.length < 2) return { changePct: null, changeLabel: 'ventas', sparkline };
  const last = ordered[ordered.length - 1];
  const lastMs = Date.parse(last.at);
  const dayAgo = lastMs - 24 * 60 * 60 * 1000;
  let prior = ordered[0];
  for (const point of ordered) {
    if (Date.parse(point.at) <= dayAgo) prior = point;
  }
  const span = lastMs - Date.parse(prior.at);
  if (!(prior.eur > 0) || !(span > 0)) return { changePct: null, changeLabel: 'ventas', sparkline };
  return {
    changePct: Math.round(((last.eur - prior.eur) / prior.eur) * 1000) / 10,
    changeLabel: span >= 20 * 60 * 60 * 1000 ? '24 h' : 'en las ventas',
    sparkline,
  };
}

export function estimateSkin(sales: SkinSale[], target: { floatValue: number; rank: number | null }): SkinEstimate | null {
  const rank = target.rank ?? rankFromFloat(sales, target.floatValue);
  if (rank != null) return fromRank(sales, rank);
  return fromFloat(sales, target.floatValue);
}
