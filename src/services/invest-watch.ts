import { buyLeft, fillBuys, investNotices, INVEST_ASSETS, type InvestBuy, type InvestFill, type InvestMove, type InvestWatch } from '../domain/invest.js';
import { todayKey } from '../domain/finance.js';
import { HttpError } from '../http.js';
import { Holding } from '../models/Holding.js';
import { Movement } from '../models/Movement.js';
import { Notification } from '../models/Notification.js';
import { Plan } from '../models/Plan.js';
import { Quote } from '../models/Quote.js';
import { User } from '../models/User.js';
import { asDay, asMoney } from '../validate.js';
import { sendToUser } from './push.js';

const PRICE_WINDOW_MS = 24 * 60 * 60 * 1000;

type BuyRow = {
  _id?: unknown;
  asset: string;
  amount: number;
  date?: string | null;
  done?: boolean | null;
  spent?: number | null;
  manual?: boolean | null;
  manualAt?: string | null;
  manualPrice?: number | null;
  movementIds?: string[] | null;
};
type WatchRow = Partial<InvestWatch> | null | undefined;
type PlanDoc = InstanceType<typeof Plan>;

function asAsset(value: unknown): string {
  if (typeof value !== 'string' || !INVEST_ASSETS[value]) throw new HttpError(400, 'Esa moneda no está en la lista del plan.');
  return value;
}

function asPct(value: unknown, field: string): number {
  if (value == null || value === '') return 0;
  const number = asMoney(value, field, true);
  if (number > 90) throw new HttpError(400, `${field} no puede pasar del 90 %.`);
  return number;
}

function nowMinute(): string {
  return new Date().toISOString().slice(0, 16);
}

/** Lee las tandas del formulario. Lo hecho no viene del formulario: sale de Movimientos y de las marcas a mano que ya había. */
export function readBuys(value: unknown, previous: BuyRow[] = []) {
  if (!Array.isArray(value)) throw new HttpError(400, 'Las compras del plan no son válidas.');
  if (value.length > 40) throw new HttpError(400, 'Son demasiadas compras para un plan.');
  return value.map((item) => {
    const row = (item || {}) as Record<string, unknown>;
    const id = typeof row.id === 'string' && /^[a-f0-9]{24}$/i.test(row.id) ? row.id : undefined;
    const before = id ? previous.find((buy) => String(buy._id) === id) : undefined;
    return {
      ...(id ? { _id: id } : {}),
      asset: asAsset(row.asset),
      amount: asMoney(row.amount, 'El importe de la compra'),
      date: row.date ? asDay(row.date, 'La fecha de la compra') : '',
      done: before?.done === true,
      manual: before?.manual === true,
      manualAt: before?.manualAt || '',
      manualPrice: before?.manualPrice ?? null,
      movementIds: [...(before?.movementIds || [])],
      spent: before?.spent ?? 0,
    };
  });
}

export function readWatch(value: unknown, previous: WatchRow) {
  const row = (value || {}) as Record<string, unknown>;
  const zones = Array.isArray(row.zones) ? row.zones : [];
  return {
    dropPct: asPct(row.dropPct, 'La caída'),
    risePct: asPct(row.risePct, 'La subida'),
    ratioAbove: row.ratioAbove == null || row.ratioAbove === '' || Number(row.ratioAbove) === 0 ? null : asMoney(row.ratioAbove, 'La línea de ETH/BTC'),
    zones: zones.slice(0, 10).map((item) => {
      const zone = (item || {}) as Record<string, unknown>;
      return { asset: asAsset(zone.asset), belowEur: asMoney(zone.belowEur, 'La zona de compra') };
    }),
    refs: (previous?.refs || []).map((ref) => ({ asset: ref.asset, priceEur: ref.priceEur, at: ref.at, source: ref.source || '' })),
    fired: [...(previous?.fired || [])],
  };
}

async function pricesFor(assets: string[]): Promise<Record<string, number | null>> {
  const quotes = await Quote.find({ key: { $in: assets.map((asset) => `coingecko:${asset}`) } });
  const prices: Record<string, number | null> = {};
  for (const asset of assets) {
    const quote = quotes.find((row) => row.key === `coingecko:${asset}`);
    const fresh = quote && quote.priceEur != null && Date.now() - new Date(quote.fetchedAt).getTime() <= PRICE_WINDOW_MS;
    prices[asset] = fresh ? (quote.priceEur as number) : null;
  }
  return prices;
}

/** Fija el precio de referencia de cada moneda que todavía no lo tiene. */
export async function fillRefs(buys: BuyRow[], watch: InvestWatch, at: string): Promise<InvestWatch> {
  const assets = [...new Set(buys.map((buy) => buy.asset))];
  const missing = assets.filter((asset) => !watch.refs.some((ref) => ref.asset === asset));
  const refs = watch.refs.filter((ref) => assets.includes(ref.asset));
  if (missing.length) {
    const prices = await pricesFor(missing);
    for (const asset of missing) {
      const price = prices[asset];
      if (price != null) refs.push({ asset, priceEur: price, at, source: '' });
    }
  }
  return { ...watch, refs };
}

/** Lo que tiene que valer la cripto de la cuenta para estar en positivo después de comprar las tandas que faltan. */
export async function breakEvenTarget(userId: string, accountId: string | null, buys: BuyRow[]): Promise<number> {
  const waiting = buys.reduce((sum, buy) => sum + buyLeft({ amount: buy.amount, done: buy.done === true, spent: buy.spent }), 0);
  if (!accountId) return Math.max(1, Math.round(buys.reduce((sum, buy) => sum + buy.amount, 0)));
  const holdings = await Holding.find({ userId, accountId, assetClass: 'crypto' }).select('costBasis quantity unitMarketValue');
  const cost = holdings.reduce((sum, row) => sum + (row.costBasis ?? (row.unitMarketValue ?? 0) * row.quantity), 0);
  return Math.max(1, Math.round((cost + waiting) * 100) / 100);
}

/**
 * Compras de la cuenta del plan, desde que empezó, de las monedas que tiene.
 * Cuentan las de Movimientos y las que se añaden desde el propio activo en Cartera.
 */
async function movesFor(userId: string, accountId: string, assets: string[], since: string, timeZone: string): Promise<InvestMove[]> {
  const holdings = await Holding.find({ userId, accountId, quoteSource: 'coingecko', quoteId: { $in: assets } }).select('_id quoteId buys');
  if (!holdings.length) return [];
  const assetOf = new Map(holdings.map((row) => [String(row._id), String(row.quoteId)]));
  const rows = await Movement.find({ userId, accountId, type: 'buy', holdingId: { $in: [...assetOf.keys()] }, date: { $gte: since } })
    .select('date amount currency eurPerUnit quantity holdingId createdAt')
    .sort({ date: 1, createdAt: 1 });
  const fromMoves = rows.flatMap((row) => {
    const eur = row.currency === 'EUR' ? row.amount : row.eurPerUnit ? row.amount * row.eurPerUnit : null;
    if (!eur || !(eur > 0) || !(row.quantity && row.quantity > 0)) return [];
    return [{ id: String(row._id), asset: assetOf.get(String(row.holdingId)) as string, date: row.date.slice(0, 10), eur, quantity: row.quantity }];
  });
  const fromHoldings = holdings.flatMap((holding) => (holding.buys || []).flatMap((buy) => {
    const day = todayKey(timeZone, new Date(buy.at));
    if (day < since || !(buy.spentEur > 0) || !(buy.quantity > 0)) return [];
    return [{ id: `h-${holding._id}-${new Date(buy.at).getTime()}`, asset: String(holding.quoteId), date: day, eur: buy.spentEur, quantity: buy.quantity }];
  }));
  return [...fromMoves, ...fromHoldings].sort((a, b) => a.date.localeCompare(b.date));
}

/** La última compra de una moneda, apuntada o marcada a mano, es la referencia de los avisos. */
function lastBuyRef(asset: string, buys: BuyRow[], fills: InvestFill[], moves: InvestMove[]) {
  const used = new Set(fills.flatMap((fill) => fill.movementIds));
  const move = moves.filter((row) => row.asset === asset && used.has(row.id)).at(-1);
  const hand = buys
    .map((buy, index) => ({ buy, fill: fills[index] }))
    .filter(({ buy, fill }) => buy.asset === asset && buy.manual && fill.movementIds.length === 0 && buy.manualPrice)
    .sort((a, b) => (a.buy.manualAt || '').localeCompare(b.buy.manualAt || ''))
    .at(-1);
  if (move && (!hand || move.date >= (hand.buy.manualAt || ''))) {
    return { asset, priceEur: move.eur / move.quantity, at: `${move.date}:${move.id.slice(-6)}`, source: `move:${move.id}` };
  }
  if (hand) {
    const id = String(hand.buy._id);
    return { asset, priceEur: hand.buy.manualPrice as number, at: `${hand.buy.manualAt}:${id.slice(-6)}`, source: `buy:${id}` };
  }
  return null;
}

/**
 * Pone las tandas al día con las compras de Movimientos: crear, cambiar o borrar una compra
 * marca, ajusta o desmarca la tanda, mueve la referencia y recalcula la meta.
 */
export async function syncInvestPlan(plan: PlanDoc, force = false): Promise<boolean> {
  const buys = plan.buys || [];
  if (plan.kind !== 'inversion' || !buys.length) return false;
  const userId = String(plan.userId);
  const accountId = plan.linkedAccountIds?.[0] ? String(plan.linkedAccountIds[0]) : null;
  const assets = [...new Set(buys.map((buy) => buy.asset))];
  const user = accountId ? await User.findById(userId).select('timezone') : null;
  const moves = accountId ? await movesFor(userId, accountId, assets, plan.startDate, user?.timezone || 'Europe/Madrid') : [];
  const fills = fillBuys(
    buys.map((buy) => ({
      id: String(buy._id),
      asset: buy.asset,
      amount: buy.amount,
      date: buy.date || '',
      manual: buy.manual === true,
      manualAt: buy.manualAt || '',
      manualPrice: buy.manualPrice ?? null,
    })),
    moves,
  );

  let changed = force;
  const finished: string[] = [];
  buys.forEach((buy, index) => {
    const fill = fills[index];
    const before = JSON.stringify([buy.done === true, buy.doneAt || '', buy.priceEur ?? null, [...(buy.movementIds || [])], buy.spent ?? 0, buy.quantity ?? 0]);
    const after = JSON.stringify([fill.done, fill.doneAt, fill.priceEur, fill.movementIds, fill.spent, fill.quantity]);
    if (before === after) return;
    if (fill.done && !buy.done) finished.push(String(buy._id));
    buy.set({ done: fill.done, doneAt: fill.doneAt, priceEur: fill.priceEur, movementIds: fill.movementIds, spent: fill.spent, quantity: fill.quantity });
    changed = true;
  });

  const refs = (plan.watch?.refs || []).map((ref) => ({ asset: ref.asset, priceEur: ref.priceEur, at: ref.at, source: ref.source || '' }));
  let fired = [...(plan.watch?.fired || [])];
  let refsChanged = false;
  const live = await pricesFor(assets);
  for (const asset of assets) {
    const wanted = lastBuyRef(asset, buys, fills, moves);
    const at = refs.findIndex((ref) => ref.asset === asset);
    const current = at >= 0 ? refs[at] : null;
    let next = current;
    if (wanted) {
      if (!current || current.source !== wanted.source || Math.abs(current.priceEur - wanted.priceEur) > 0.005) next = wanted;
    } else if (current?.source) {
      next = live[asset] != null ? { asset, priceEur: live[asset] as number, at: nowMinute(), source: '' } : { ...current, source: '' };
    }
    if (next === current || !next) continue;
    if (at >= 0) refs[at] = next;
    else refs.push(next);
    fired = fired.filter((flag) => !flag.startsWith(`drop:${asset}:`) && !flag.startsWith(`rise:${asset}:`));
    refsChanged = true;
  }
  if (refsChanged) {
    plan.set('watch.refs', refs);
    plan.set('watch.fired', fired);
  }

  const target = await breakEvenTarget(userId, accountId, buys);
  if (Math.abs(target - plan.targetAmount) >= 0.01) {
    plan.targetAmount = target;
    changed = true;
  }
  if (!changed && !refsChanged) return false;
  await plan.save();
  if (finished.length) {
    await Notification.deleteMany({ userId, quoteKey: { $regex: `^plan-inv:${plan._id}:(day|eve):(${finished.join('|')}):` } });
  }
  return true;
}

/** Repasa todos los planes de compras del usuario; se llama después de tocar un movimiento. */
export async function syncInvestPlans(userId: string): Promise<void> {
  try {
    const plans = await Plan.find({ userId, kind: 'inversion', 'buys.0': { $exists: true } });
    for (const plan of plans) await syncInvestPlan(plan);
  } catch (err) {
    console.error('No se han podido poner al día los planes de compras', err);
  }
}

/** Precio, media y media después de las tandas pendientes de cada moneda del plan. */
export async function investView(userId: string, plan: { linkedAccountIds?: unknown[]; buys?: BuyRow[] | null; watch?: WatchRow }) {
  const buys = plan.buys || [];
  if (!buys.length) return null;
  const assets = [...new Set(buys.map((buy) => buy.asset))];
  const prices = await pricesFor(assets);
  const accountId = plan.linkedAccountIds?.[0] ? String(plan.linkedAccountIds[0]) : null;
  const holdings = await Holding.find({ userId, ...(accountId ? { accountId } : {}), quoteSource: 'coingecko', quoteId: { $in: assets } }).select('quoteId quantity costBasis');
  const rows = assets.map((asset) => {
    const own = holdings.filter((row) => row.quoteId === asset);
    const quantity = own.reduce((sum, row) => sum + row.quantity, 0);
    const cost = own.reduce((sum, row) => sum + (row.costBasis ?? 0), 0);
    const price = prices[asset];
    const pending = buys.filter((buy) => buy.asset === asset).reduce((sum, buy) => sum + buyLeft({ amount: buy.amount, done: buy.done === true, spent: buy.spent }), 0);
    const ref = (plan.watch?.refs || []).find((row) => row.asset === asset) || null;
    const zone = (plan.watch?.zones || []).find((row) => row.asset === asset) || null;
    const after = price && quantity + pending / price > 0 ? (cost + pending) / (quantity + pending / price) : null;
    return {
      asset,
      name: INVEST_ASSETS[asset] || asset,
      priceEur: price,
      quantity,
      cost,
      average: quantity > 0 && cost > 0 ? cost / quantity : null,
      pending,
      averageAfter: after,
      refEur: ref?.priceEur ?? null,
      changePct: ref && price ? (price / ref.priceEur - 1) * 100 : null,
      zoneEur: zone?.belowEur ?? null,
    };
  });
  const btc = prices.bitcoin;
  const eth = prices.ethereum;
  return { assets: rows, ratio: btc && eth ? eth / btc : null };
}

export async function investCoins(): Promise<string[]> {
  const assets = await Plan.distinct('buys.asset', { kind: 'inversion', 'buys.done': false });
  return assets.map(String).filter((asset) => Boolean(INVEST_ASSETS[asset]));
}

export async function checkInvestPlans(): Promise<void> {
  const plans = await Plan.find({ kind: 'inversion', 'buys.done': false });
  if (!plans.length) return;
  const assets = [...new Set(plans.flatMap((plan) => (plan.buys || []).map((buy) => buy.asset)))];
  const prices = await pricesFor(assets);
  const zones = new Map<string, string>();
  for (const plan of plans) {
    await syncInvestPlan(plan);
    if (!(plan.buys || []).some((buy) => !buy.done)) continue;
    const userId = String(plan.userId);
    if (!zones.has(userId)) {
      const user = await User.findById(userId).select('timezone');
      zones.set(userId, user?.timezone || 'Europe/Madrid');
    }
    const today = todayKey(zones.get(userId) as string);
    const buys: InvestBuy[] = (plan.buys || []).map((buy) => ({
      id: String(buy._id),
      asset: buy.asset,
      amount: buy.amount,
      date: buy.date || '',
      done: buy.done === true,
      spent: buy.spent ?? 0,
    }));
    const stored = plan.watch;
    let watch: InvestWatch = {
      dropPct: stored?.dropPct ?? 5,
      risePct: stored?.risePct ?? 8,
      ratioAbove: stored?.ratioAbove ?? null,
      zones: (stored?.zones || []).map((zone) => ({ asset: zone.asset, belowEur: zone.belowEur })),
      refs: (stored?.refs || []).map((ref) => ({ asset: ref.asset, priceEur: ref.priceEur, at: ref.at, source: ref.source || '' })),
      fired: [...(stored?.fired || [])],
    };
    const refCount = watch.refs.length;
    watch = await fillRefs(buys, watch, today);
    const { notices, fired } = investNotices({ planId: String(plan._id), planName: plan.name, buys, watch, prices, today, stamp: Date.now() });
    for (const notice of notices) {
      const exists = await Notification.exists({ userId, quoteKey: notice.key });
      if (exists) continue;
      await Notification.create({
        userId,
        quoteKey: notice.key,
        title: notice.title,
        body: notice.body,
        direction: notice.direction,
        changePct: notice.changePct,
        priceEur: notice.priceEur,
      });
      void sendToUser(userId, { title: notice.title, body: notice.body, url: '/' }).catch(() => undefined);
    }
    const sameFired = fired.length === watch.fired.length && fired.every((flag) => watch.fired.includes(flag));
    if (!sameFired || watch.refs.length !== refCount) {
      await Plan.updateOne({ _id: plan._id }, { $set: { 'watch.fired': fired, 'watch.refs': watch.refs } });
    }
  }
}

/** Marca o desmarca a mano una tanda que no viene de Movimientos. */
/** Cambia el importe o la fecha de una tanda, o la quita del plan si `change` es null. */
export async function editBuy(userId: string, planId: string, buyId: string, change: { amount: number; date: string } | null) {
  const plan = await Plan.findOne({ _id: planId, userId, kind: 'inversion' });
  if (!plan) throw new HttpError(404, 'Ese plan no existe.');
  const buy = (plan.buys || []).find((row) => String(row._id) === buyId);
  if (!buy) throw new HttpError(404, 'Esa tanda no está en el plan.');
  const linked = (buy.movementIds || []).length > 0;
  if (change) {
    if (linked && change.amount < (buy.spent || 0) - 0.005) {
      throw new HttpError(400, `Ya llevas ${(buy.spent || 0).toFixed(2).replace('.', ',')} € en esta tanda; el importe tiene que ser igual o mayor.`);
    }
    buy.set({ amount: change.amount, date: change.date });
  } else {
    if (linked) throw new HttpError(400, 'Esta tanda ya tiene compras tuyas. Borra o cambia esas compras en Movimientos y después podrás quitarla.');
    if ((plan.buys || []).length <= 1) throw new HttpError(400, 'El plan necesita al menos una tanda. Si ya no lo quieres, borra el plan.');
    plan.buys?.pull(buy._id);
  }
  await Notification.deleteMany({ userId, quoteKey: { $regex: `^plan-inv:${plan._id}:(day|eve):${buyId}:` } });
  await syncInvestPlan(plan, true);
  return plan;
}

export async function settleBuy(userId: string, planId: string, buyId: string, done: boolean, price: number | null) {
  const plan = await Plan.findOne({ _id: planId, userId, kind: 'inversion' });
  if (!plan) throw new HttpError(404, 'Ese plan no existe.');
  const buy = (plan.buys || []).find((row) => String(row._id) === buyId);
  if (!buy) throw new HttpError(404, 'Esa compra no está en el plan.');
  if (!done && (buy.movementIds || []).length > 0) {
    throw new HttpError(400, 'Esta tanda sale de tus compras en Movimientos. Cambia o borra la compra allí.');
  }
  const user = await User.findById(userId).select('timezone');
  const today = todayKey(user?.timezone || 'Europe/Madrid');
  const live = done ? price ?? (await pricesFor([buy.asset]))[buy.asset] : null;
  buy.set({ manual: done, manualAt: done ? today : '', manualPrice: done ? live ?? null : null });
  await syncInvestPlan(plan, true);
  return plan;
}
