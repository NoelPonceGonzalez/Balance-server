export const INVEST_ASSETS: Record<string, string> = {
  bitcoin: 'Bitcoin',
  ethereum: 'Ethereum',
  solana: 'Solana',
  ripple: 'XRP',
  binancecoin: 'BNB',
  cardano: 'Cardano',
};

export interface InvestBuy {
  id: string;
  asset: string;
  amount: number;
  date: string;
  done: boolean;
  /** Lo que ya ha entrado desde movimientos en una tanda a medias. */
  spent?: number;
}

/** Una compra apuntada en Movimientos, ya en euros. */
export interface InvestMove {
  id: string;
  asset: string;
  date: string;
  eur: number;
  quantity: number;
}

export interface InvestSlot {
  id: string;
  asset: string;
  amount: number;
  date: string;
  manual: boolean;
  manualAt: string;
  manualPrice: number | null;
}

export interface InvestFill {
  id: string;
  movementIds: string[];
  spent: number;
  quantity: number;
  done: boolean;
  doneAt: string;
  priceEur: number | null;
}

const DUE_WINDOW_DAYS = 2;
const FULL_SHARE = 0.95;

function dayNumber(day: string): number {
  const [year, month, date] = day.slice(0, 10).split('-').map(Number);
  return Date.UTC(year, month - 1, date) / 86_400_000;
}

/** Orden en que una compra llena tandas: primero las empezadas, luego las marcadas a mano, las que tocan, las de aviso y las futuras. */
function slotRank(slot: InvestSlot, spent: number, moveDay: number): [number, number] {
  if (spent > 0) return [0, 0];
  if (slot.manual) return [1, slot.manualAt ? Math.abs(dayNumber(slot.manualAt) - moveDay) : 0];
  if (!slot.date) return [3, 0];
  const gap = dayNumber(slot.date) - moveDay;
  if (gap <= DUE_WINDOW_DAYS) return [2, Math.abs(gap)];
  return [4, gap];
}

/**
 * Reparte las compras apuntadas entre las tandas del plan.
 * Se calcula entero cada vez, así crear, cambiar o borrar un movimiento deja las tandas bien.
 */
export function fillBuys(slots: InvestSlot[], moves: InvestMove[]): InvestFill[] {
  const state = new Map(slots.map((slot) => [slot.id, { movementIds: [] as string[], spent: 0, quantity: 0, lastDay: '' }]));
  const ordered = [...moves].filter((move) => move.eur > 0).sort((a, b) => a.date.localeCompare(b.date));
  for (const move of ordered) {
    const day = dayNumber(move.date);
    let left = move.eur;
    let last: InvestSlot | null = null;
    while (left > 0.005) {
      const open = slots
        .filter((slot) => slot.asset === move.asset)
        .map((slot) => ({ slot, row: state.get(slot.id)!, cap: slot.amount - state.get(slot.id)!.spent }))
        .filter((item) => item.cap > 0.005)
        .sort((a, b) => {
          const ra = slotRank(a.slot, a.row.spent, day);
          const rb = slotRank(b.slot, b.row.spent, day);
          return ra[0] - rb[0] || ra[1] - rb[1];
        });
      const pick = open[0];
      if (!pick) {
        if (last) {
          const row = state.get(last.id)!;
          row.spent += left;
          row.quantity += move.quantity * (left / move.eur);
        }
        break;
      }
      const rest = left - pick.cap;
      const take = rest <= move.eur * (1 - FULL_SHARE) ? left : pick.cap;
      const row = pick.row;
      row.spent += take;
      row.quantity += move.quantity * (take / move.eur);
      if (!row.movementIds.includes(move.id)) row.movementIds.push(move.id);
      if (move.date > row.lastDay) row.lastDay = move.date;
      left -= take;
      last = pick.slot;
    }
  }
  return slots.map((slot) => {
    const row = state.get(slot.id)!;
    const spent = Math.round(row.spent * 100) / 100;
    const filled = row.movementIds.length > 0;
    const done = slot.manual || (filled && spent >= slot.amount * FULL_SHARE);
    return {
      id: slot.id,
      movementIds: row.movementIds,
      spent,
      quantity: row.quantity,
      done,
      doneAt: filled && done ? row.lastDay : slot.manual ? slot.manualAt : '',
      priceEur: row.quantity > 0 ? spent / row.quantity : slot.manual ? slot.manualPrice : null,
    };
  });
}

/** Lo que falta por meter en una tanda. */
export function buyLeft(buy: { amount: number; done?: boolean; spent?: number | null }): number {
  if (buy.done) return 0;
  return Math.max(0, buy.amount - (buy.spent ?? 0));
}

export interface InvestWatch {
  dropPct: number;
  risePct: number;
  ratioAbove: number | null;
  zones: { asset: string; belowEur: number }[];
  /** `source` dice de dónde sale: vacío es el precio del día que empezó, `move:<id>` una compra apuntada, `buy:<id>` una tanda marcada a mano. */
  refs: { asset: string; priceEur: number; at: string; source?: string }[];
  fired: string[];
}

export interface InvestNotice {
  key: string;
  title: string;
  body: string;
  direction: 'up' | 'down' | 'due';
  asset: string | null;
  changePct: number | null;
  priceEur: number | null;
  /** Agrupa el aviso del móvil para que un cambio de momento sustituya al anterior. */
  tag?: string;
  /** Buen momento, muy bueno o esperar. Sirve para elegir la imagen del aviso. */
  band?: MomentBand;
}

/** Misma lectura que la ficha del plan: zona, media, referencia y día. */
export type MomentBand = 'great' | 'good' | 'normal' | 'bad';

const GOOD_SCORE = 1.5;
const GREAT_SCORE = 3;
const BAD_SCORE = -0.5;

/** Puntúa el precio de ahora. El cliente usa los mismos umbrales para buscar a qué precio cambiaría. */
export function momentBand(input: {
  price: number;
  zone: number | null;
  average: number | null;
  ref: number | null;
  day: number | null;
  drop: number;
  rise: number;
}): MomentBand {
  let score = 0;
  const { price } = input;
  if (input.zone != null && input.zone > 0) {
    const gap = (price / input.zone - 1) * 100;
    if (gap <= 0) score += 2;
    else if (gap <= 5) score += 0.5;
  }
  if (input.average != null && input.average > 0) {
    const gap = (price / input.average - 1) * 100;
    if (gap < -5) score += 1;
    else if (gap > 5) score -= 0.5;
  }
  if (input.ref != null && input.ref > 0) {
    const change = (price / input.ref - 1) * 100;
    if (change <= -input.drop) score += 1;
    else if (change <= -2) score += 0.5;
    else if (change >= input.rise) score -= 1;
    else if (change >= 3) score -= 0.5;
  }
  if (input.day != null) {
    if (input.day <= -3) score += 0.5;
    else if (input.day >= 4) score -= 0.5;
  }
  if (score >= GREAT_SCORE) return 'great';
  if (score >= GOOD_SCORE) return 'good';
  if (score <= BAD_SCORE) return 'bad';
  return 'normal';
}

export function assetName(asset: string): string {
  return INVEST_ASSETS[asset] || asset;
}

function euros(amount: number): string {
  const digits = amount >= 1000 || Number.isInteger(amount) ? 0 : 2;
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: 'always' as unknown as boolean })
    .format(amount)
    .replace(/\s/g, ' ');
}

function pct(value: number): string {
  return `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(Math.abs(value))} %`;
}

function nextDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

function waitingFor(buys: InvestBuy[], asset: string): number {
  return buys.filter((buy) => buy.asset === asset).reduce((sum, buy) => sum + buyLeft(buy), 0);
}

/**
 * Decide qué avisos tocan para un plan de compras con los precios de ahora.
 * Devuelve también la lista de avisos armados, que se guarda para no repetirlos.
 */
export function investNotices(input: {
  planId: string;
  planName: string;
  buys: InvestBuy[];
  watch: InvestWatch;
  prices: Record<string, number | null | undefined>;
  today: string;
  stamp: number;
  /** Lectura de momento de cada moneda. Si no viene, el plan no avisa por buen momento. */
  moments?: { asset: string; band: MomentBand }[];
}): { notices: InvestNotice[]; fired: string[] } {
  const { planId, planName, buys, watch, prices, today, stamp, moments = [] } = input;
  const notices: InvestNotice[] = [];
  const fired = new Set(watch.fired);
  const pending = buys.filter((buy) => !buy.done);
  if (pending.length === 0) return { notices, fired: [] };

  for (const buy of pending) {
    if (!buy.date) continue;
    const name = assetName(buy.asset);
    const amount = buyLeft(buy);
    if (buy.date === today) {
      notices.push({
        key: `plan-inv:${planId}:day:${buy.id}:${buy.date}`,
        title: `Hoy toca comprar ${euros(amount)} de ${name}`,
        body: prices[buy.asset] != null ? `${planName} · ${name} va por ${euros(prices[buy.asset] as number)}. Al apuntar la compra en Movimientos, la tanda se marca sola.` : `${planName} · al apuntar la compra en Movimientos, la tanda se marca sola.`,
        direction: 'due',
        asset: buy.asset,
        changePct: null,
        priceEur: prices[buy.asset] ?? null,
      });
    } else if (nextDay(today) === buy.date) {
      notices.push({
        key: `plan-inv:${planId}:eve:${buy.id}:${buy.date}`,
        title: `Mañana toca comprar ${euros(amount)} de ${name}`,
        body: `${planName} · mira el mercado antes de comprar.`,
        direction: 'due',
        asset: buy.asset,
        changePct: null,
        priceEur: prices[buy.asset] ?? null,
      });
    }
  }

  const assets = [...new Set(pending.map((buy) => buy.asset))];
  for (const asset of assets) {
    const price = prices[asset];
    if (price == null || !(price > 0)) continue;
    const name = assetName(asset);
    const left = waitingFor(buys, asset);
    const ref = watch.refs.find((row) => row.asset === asset);
    if (ref && ref.priceEur > 0) {
      const change = (price / ref.priceEur - 1) * 100;
      if (watch.dropPct > 0 && change <= -watch.dropPct) {
        const step = Math.floor(-change / watch.dropPct);
        const flag = `drop:${asset}:${ref.at}:${step}`;
        if (!fired.has(flag)) {
          fired.add(flag);
          notices.push({
            key: `plan-inv:${planId}:${flag}`,
            title: `${name} baja un ${pct(change)} desde tu referencia`,
            body: `Va por ${euros(price)} (referencia ${euros(ref.priceEur)}). Te quedan ${euros(left)} para ${name} en ${planName}. Revisa si es el momento.`,
            direction: 'down',
            asset,
            changePct: change,
            priceEur: price,
          });
        }
      }
      if (watch.risePct > 0 && change >= watch.risePct) {
        const step = Math.floor(change / watch.risePct);
        const flag = `rise:${asset}:${ref.at}:${step}`;
        if (!fired.has(flag)) {
          fired.add(flag);
          notices.push({
            key: `plan-inv:${planId}:${flag}`,
            title: `${name} sube un ${pct(change)} desde tu referencia`,
            body: `Va por ${euros(price)} (referencia ${euros(ref.priceEur)}). Si esperas más, la media sale más cara. Revisa ${planName}.`,
            direction: 'up',
            asset,
            changePct: change,
            priceEur: price,
          });
        }
      }
    }
    const zone = watch.zones.find((row) => row.asset === asset);
    if (zone && zone.belowEur > 0) {
      const flag = `zone:${asset}`;
      if (price <= zone.belowEur && !fired.has(flag)) {
        fired.add(flag);
        notices.push({
          key: `plan-inv:${planId}:zone:${asset}:${stamp}`,
          title: `${name} entra en tu zona de compra`,
          body: `Va por ${euros(price)}, por debajo de ${euros(zone.belowEur)}. Te quedan ${euros(left)} para ${name} en ${planName}.`,
          direction: 'down',
          asset,
          changePct: null,
          priceEur: price,
        });
      } else if (price > zone.belowEur * 1.03) {
        fired.delete(flag);
      }
    }
  }

  const btc = prices.bitcoin;
  const eth = prices.ethereum;
  if (watch.ratioAbove != null && watch.ratioAbove > 0 && btc && eth && assets.includes('ethereum')) {
    const ratio = eth / btc;
    const flag = 'ratio:ethereum';
    if (ratio >= watch.ratioAbove && !fired.has(flag)) {
      fired.add(flag);
      notices.push({
        key: `plan-inv:${planId}:ratio:${stamp}`,
        title: 'Ethereum gana terreno a Bitcoin',
        body: `ETH/BTC está en ${ratio.toFixed(4).replace('.', ',')}, por encima de ${watch.ratioAbove.toFixed(4).replace('.', ',')}. Puede tocar pasar más peso a Ethereum en ${planName}.`,
        direction: 'up',
        asset: 'ethereum',
        changePct: null,
        priceEur: eth,
      });
    } else if (ratio < watch.ratioAbove * 0.98) {
      fired.delete(flag);
    }
  }

  for (const moment of moments) {
    if (!assets.includes(moment.asset)) continue;
    const prefix = `moment:${moment.asset}:`;
    const previous = [...fired].find((flag) => flag.startsWith(prefix)) || '';
    for (const flag of [...fired]) if (flag.startsWith(prefix)) fired.delete(flag);
    fired.add(`${prefix}${moment.band}`);
    if (moment.band === 'normal' || previous === `${prefix}${moment.band}`) continue;
    if (moment.band === 'good' && previous === `${prefix}great`) continue;
    const price = prices[moment.asset];
    if (price == null || !(price > 0)) continue;
    const name = assetName(moment.asset);
    const left = waitingFor(buys, moment.asset);
    const title = moment.band === 'great'
      ? `${name} está en un momento muy bueno para comprar`
      : moment.band === 'good'
        ? `${name} está en buen momento para comprar`
        : `${name}: mejor esperar para comprar`;
    const body = moment.band === 'bad'
      ? `Va por ${euros(price)}. Te quedan ${euros(left)} para ${name} en ${planName}. El plan marca esperar.`
      : `Va por ${euros(price)}. Te quedan ${euros(left)} para ${name} en ${planName}.`;
    notices.push({
      key: `plan-inv:${planId}:moment:${moment.asset}:${moment.band}:${stamp}`,
      tag: `moment:${planId}:${moment.asset}`,
      band: moment.band,
      title,
      body,
      direction: moment.band === 'bad' ? 'up' : 'down',
      asset: moment.asset,
      changePct: null,
      priceEur: price,
    });
  }

  return { notices, fired: [...fired] };
}
