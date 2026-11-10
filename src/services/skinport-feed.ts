import { io, type Socket } from 'socket.io-client';
import parser from 'socket.io-msgpack-parser';
import { roundMoney } from '../domain/finance.js';
import type { OpenAsk } from './skins.js';

/** Skinport no vuelve a mandar los anuncios ya puestos ni avisa de cancelados: se olvidan pasado este tiempo. */
const KEEP_MS = 3 * 24 * 60 * 60_000;
const PER_NAME = 40;

type FeedSale = {
  saleId?: number | null;
  assetid?: string | null;
  url?: string;
  marketHashName?: string;
  salePrice?: number;
  suggestedPrice?: number;
  wear?: number | null;
  pattern?: number | null;
  image?: string;
};

type Listed = OpenAsk & { key: string; at: number };

const board = new Map<string, Listed[]>();
let socket: Socket | null = null;
let live = false;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function saleKey(sale: FeedSale): string | null {
  if (sale.saleId != null) return `sale:${sale.saleId}`;
  if (sale.assetid) return `asset:${sale.assetid}`;
  return null;
}

function remember(sale: FeedSale) {
  const name = sale.marketHashName;
  const cents = finite(sale.salePrice);
  const key = saleKey(sale);
  if (!name || !key || cents == null || !(cents > 0) || !sale.url) return;
  const suggested = finite(sale.suggestedPrice);
  const floatValue = finite(sale.wear);
  const row: Listed = {
    key,
    at: Date.now(),
    market: 'Skinport',
    id: `skinport:${key}:${Math.round(cents)}`,
    eur: roundMoney(cents / 100),
    url: sale.saleId != null ? `https://skinport.com/item/${sale.url}/${sale.saleId}` : `https://skinport.com/item/${sale.url}`,
    floatValue: floatValue != null && floatValue >= 0 && floatValue <= 1 ? floatValue : null,
    paintSeed: finite(sale.pattern),
    referenceEur: suggested && suggested > 0 ? roundMoney(suggested / 100) : null,
    image: sale.image ? `https://community.cloudflare.steamstatic.com/economy/image/${sale.image}` : null,
  };
  const rows = (board.get(name) || []).filter((item) => item.key !== key);
  rows.push(row);
  board.set(name, rows.slice(-PER_NAME));
}

function forget(sale: FeedSale) {
  const name = sale.marketHashName;
  const key = saleKey(sale);
  if (!name || !key) return;
  const rows = board.get(name);
  if (rows) board.set(name, rows.filter((item) => item.key !== key));
}

export function startSkinportFeed() {
  if (socket) return;
  socket = io('wss://skinport.com', { transports: ['websocket'], parser });
  socket.on('connect', () => {
    live = true;
    socket?.emit('saleFeedJoin', { currency: 'EUR', locale: 'en', appid: 730 });
  });
  socket.on('disconnect', () => { live = false; });
  socket.on('connect_error', () => { live = false; });
  socket.on('saleFeed', (result: { eventType?: string; sales?: FeedSale[] }) => {
    const sales = Array.isArray(result?.sales) ? result.sales : [];    if (result.eventType === 'listed') sales.forEach(remember);
    else if (result.eventType === 'sold') sales.forEach(forget);
  });
}

/** Anuncios de Skinport vistos en directo, con su float. `null` si el directo no está conectado. */
export function skinportAsks(name: string): OpenAsk[] | null {
  const rows = board.get(name);
  const fresh = (rows || []).filter((row) => Date.now() - row.at < KEEP_MS);
  if (rows && fresh.length !== rows.length) board.set(name, fresh);
  if (!live && fresh.length === 0) return null;
  return fresh.map(({ key: _key, at: _at, ...ask }) => ask);
}
