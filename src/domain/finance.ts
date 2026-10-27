/** Cálculos de patrimonio. Funciones puras: mismos datos, mismo resultado. */

export type AccountKind = 'bank' | 'cash' | 'broker' | 'exchange' | 'wallet' | 'other';
export type Tracking = 'balance' | 'positions';
export type AssetClass = 'crypto' | 'stock' | 'etf' | 'personal_good' | 'other';
export type MovementType =
  | 'income'
  | 'expense'
  | 'buy'
  | 'sell'
  | 'fee'
  | 'transfer'
  | 'deposit'
  | 'withdrawal'
  | 'reward'
  | 'adjustment';

export interface AccountSnap {
  id: string;
  name: string;
  kind: AccountKind;
  tracking: Tracking;
  currency: string;
  balance: number;
  /** Euros por 1 unidad de `currency`. null si no es EUR y no hay tipo manual. */
  eurPerUnit: number | null;
  updatedAt: string | null;
}

export interface HoldingSnap {
  id: string;
  accountId: string;
  name: string;
  assetClass: AssetClass;
  currency: string;
  quantity: number;
  /** Precio por unidad. Puede venir de una cotización o de un importe escrito a mano. */
  unitMarketValue: number | null;
  priceSource?: 'manual' | 'market';
  /** Coste total de adquisición en `currency`. No es el valor de mercado. */
  costBasis: number | null;
  eurPerUnit: number | null;
  valuedAt: string | null;
}

export interface MovementSnap {
  id: string;
  type: MovementType;
  date: string;
  amount: number;
  currency: string;
  eurPerUnit: number | null;
  accountId: string;
  counterAccountId?: string | null;
  /** Coste de lo vendido, en la moneda del activo. null si no se conoce. */
  costOfSold?: number | null;
  costCurrency?: string | null;
  costEurPerUnit?: number | null;
  fee?: number | null;
  feeCurrency?: string | null;
  feeEurPerUnit?: number | null;
}

export interface Valued {
  eur: number;
  /** false cuando falta precio, tipo de cambio o parte de las posiciones. */
  complete: boolean;
  excluded: string[];
}

export interface PortfolioLine {
  key: string;
  accountId: string;
  label: string;
  eur: number | null;
  bucket: 'available' | 'invested' | 'crypto' | 'personal' | 'excluded';
  note?: string;
}

export interface Portfolio {
  netWorth: Valued;
  available: Valued;
  invested: Valued;
  crypto: Valued;
  personalGoods: Valued;
  unrealized: Valued;
  lines: PortfolioLine[];
  warnings: string[];
}

export function roundMoney(n: number, decimals = 2): number {
  if (!Number.isFinite(n)) return NaN;
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

export function roundQty(n: number): number {
  return roundMoney(n, 8);
}

export interface Converted {
  eur: number | null;
  ok: boolean;
}

export function toEur(amount: number, currency: string, eurPerUnit: number | null): Converted {
  if (!Number.isFinite(amount)) return { eur: null, ok: false };
  const code = currency.trim().toUpperCase();
  if (code === 'EUR') return { eur: roundMoney(amount), ok: true };
  if (eurPerUnit == null || !(eurPerUnit > 0) || !Number.isFinite(eurPerUnit)) return { eur: null, ok: false };
  return { eur: roundMoney(amount * eurPerUnit), ok: true };
}

function emptyValued(): Valued {
  return { eur: 0, complete: true, excluded: [] };
}

function addValued(target: Valued, eur: number | null, label: string): void {
  if (eur == null) {
    target.complete = false;
    target.excluded.push(label);
    return;
  }
  target.eur = roundMoney(target.eur + eur);
}

function positionValue(holding: HoldingSnap): number | null {
  if (holding.quantity <= 0) return 0;
  if (holding.unitMarketValue == null || !Number.isFinite(holding.unitMarketValue)) return null;
  return roundMoney(holding.unitMarketValue * holding.quantity, 8);
}

export function valuePortfolio(accounts: AccountSnap[], holdings: HoldingSnap[]): Portfolio {
  const available = emptyValued();
  const invested = emptyValued();
  const crypto = emptyValued();
  const personalGoods = emptyValued();
  const unrealized = emptyValued();
  const lines: PortfolioLine[] = [];
  const warnings: string[] = [];
  const byId = new Map(accounts.map((a) => [a.id, a]));

  for (const account of accounts) {
    const cash = toEur(account.balance, account.currency, account.eurPerUnit);
    const label = `${account.name}: efectivo ${account.balance} ${account.currency}`;
    const bucket: PortfolioLine['bucket'] =
      account.tracking === 'positions' || account.kind === 'bank' || account.kind === 'cash'
        ? 'available'
        : account.kind === 'wallet'
          ? 'crypto'
          : 'invested';
    const target = bucket === 'available' ? available : bucket === 'crypto' ? crypto : invested;
    addValued(target, cash.eur, label);
    lines.push({
      key: `cash:${account.id}`,
      accountId: account.id,
      label: account.name,
      eur: cash.eur,
      bucket: cash.ok ? bucket : 'excluded',
      note: cash.ok ? undefined : 'Sin tipo de cambio a euros',
    });
    if (!cash.ok) warnings.push(`${account.name} está en ${account.currency} y no tiene tipo de cambio a euros, así que queda fuera del total.`);
  }

  for (const holding of holdings) {
    const account = byId.get(holding.accountId);
    const name = holding.name || 'Activo';
    if (!account) {
      unrealized.complete = false;
      warnings.push(`${name} no tiene cuenta y queda fuera del patrimonio.`);
      continue;
    }
    if (account.tracking === 'balance') {
      warnings.push(
        `${name} no se suma al patrimonio: en ${account.name} el saldo ya es el valor de la cuenta. El coste de adquisición no se usa como precio.`,
      );
      continue;
    }

    const gross = positionValue(holding);
    const converted = gross == null ? { eur: null, ok: false } : toEur(gross, holding.currency, holding.eurPerUnit);
    const bucket: PortfolioLine['bucket'] =
      holding.assetClass === 'crypto' ? 'crypto' : holding.assetClass === 'personal_good' ? 'personal' : 'invested';
    const target = bucket === 'crypto' ? crypto : bucket === 'personal' ? personalGoods : invested;

    if (holding.quantity <= 0) {
      lines.push({ key: `h:${holding.id}`, accountId: account.id, label: name, eur: 0, bucket, note: 'Posición cerrada' });
      continue;
    }

    addValued(target, converted.ok ? converted.eur : null, `${name} (${account.name})`);
    lines.push({
      key: `h:${holding.id}`,
      accountId: account.id,
      label: name,
      eur: converted.eur,
      bucket: converted.ok ? bucket : 'excluded',
      note: converted.ok ? (holding.priceSource === 'market' ? 'Cotización de mercado' : 'Precio manual') : gross == null ? 'Sin valor de mercado' : 'Sin tipo de cambio a euros',
    });
    if (gross == null) {
      warnings.push(`${name} no tiene valor de mercado. Su coste de adquisición no se ha usado como precio.`);
    } else if (!converted.ok) {
      warnings.push(`${name} está en ${holding.currency} y no tiene tipo de cambio a euros.`);
    }

    const cost = holding.costBasis == null ? null : toEur(holding.costBasis, holding.currency, holding.eurPerUnit);
    if (converted.ok && cost?.ok && cost.eur != null && converted.eur != null) {
      unrealized.eur = roundMoney(unrealized.eur + (converted.eur - cost.eur));
    } else if (holding.quantity > 0) {
      unrealized.complete = false;
      unrealized.excluded.push(name);
    }
  }

  const net = emptyValued();
  for (const part of [available, invested, crypto, personalGoods]) {
    net.eur = roundMoney(net.eur + part.eur);
    if (!part.complete) net.complete = false;
    net.excluded.push(...part.excluded);
  }

  if (!unrealized.complete) {
    warnings.push('La ganancia no realizada está incompleta: hay posiciones sin coste o sin valor de mercado.');
  }

  return { netWorth: net, available, invested, crypto, personalGoods, unrealized, lines, warnings };
}

/** Efecto en el saldo de la cuenta. La compraventa mueve dinero, pero no es una aportación. */
export function cashSign(type: MovementType): number {
  switch (type) {
    case 'income':
    case 'deposit':
    case 'reward':
    case 'sell':
      return 1;
    case 'expense':
    case 'withdrawal':
    case 'fee':
    case 'buy':
      return -1;
    default:
      return 0;
  }
}

/**
 * Dinero que entra o sale del patrimonio (nómina, gastos, comisiones, depósitos y retiradas).
 * Transferencias, compras, ventas, recompensas y ajustes no son aportaciones:
 * la recompensa cuenta como ganancia, no como dinero nuevo que hayas ingresado tú.
 */
export function externalFlowSign(type: MovementType): number {
  switch (type) {
    case 'income':
    case 'deposit':
      return 1;
    case 'expense':
    case 'withdrawal':
    case 'fee':
      return -1;
    default:
      return 0;
  }
}

export interface FlowResult {
  contributions: Valued;
  realized: Valued;
  fees: Valued;
}

export function analyzeMovements(movements: MovementSnap[], fromDay: string | null, toDay: string | null): FlowResult {
  const contributions = emptyValued();
  const realized = emptyValued();
  const fees = emptyValued();

  for (const movement of movements) {
    const day = movement.date.slice(0, 10);
    if (fromDay && day < fromDay) continue;
    if (toDay && day > toDay) continue;

    const sign = externalFlowSign(movement.type);
    if (sign !== 0) {
      const converted = toEur(movement.amount, movement.currency, movement.eurPerUnit);
      if (!converted.ok || converted.eur == null) addValued(contributions, null, movement.id);
      else addValued(contributions, roundMoney(sign * converted.eur), movement.id);
    }

    if (movement.fee != null && movement.fee > 0) {
      const fee = toEur(movement.fee, movement.feeCurrency || movement.currency, movement.feeEurPerUnit ?? movement.eurPerUnit);
      addValued(fees, fee.ok ? fee.eur : null, movement.id);
    } else if (movement.type === 'fee') {
      const fee = toEur(movement.amount, movement.currency, movement.eurPerUnit);
      addValued(fees, fee.ok ? fee.eur : null, movement.id);
    }

    if (movement.type === 'sell') {
      const proceeds = toEur(movement.amount, movement.currency, movement.eurPerUnit);
      if (movement.costOfSold == null) {
        realized.complete = false;
        realized.excluded.push(movement.id);
      } else {
        const cost = toEur(
          movement.costOfSold,
          movement.costCurrency || movement.currency,
          movement.costEurPerUnit ?? movement.eurPerUnit,
        );
        if (!proceeds.ok || !cost.ok || proceeds.eur == null || cost.eur == null) {
          realized.complete = false;
          realized.excluded.push(movement.id);
        } else {
          realized.eur = roundMoney(realized.eur + (proceeds.eur - cost.eur));
        }
      }
    }

    if (movement.type === 'reward') {
      const reward = toEur(movement.amount, movement.currency, movement.eurPerUnit);
      if (!reward.ok || reward.eur == null) {
        realized.complete = false;
        realized.excluded.push(movement.id);
      } else {
        realized.eur = roundMoney(realized.eur + reward.eur);
      }
    }
  }

  return { contributions, realized, fees };
}

export interface SnapshotPoint {
  day: string;
  netWorthEur: number | null;
}

export interface Variation {
  available: boolean;
  amount: number | null;
  percent: number | null;
  baseDay: string | null;
  note: string;
}

export function variationFromSnapshots(
  snapshots: SnapshotPoint[],
  today: string,
  todayValue: number | null,
  fromDay: string,
): Variation {
  if (todayValue == null) {
    return { available: false, amount: null, percent: null, baseDay: null, note: 'El patrimonio de hoy no está cerrado: faltan precios o tipos de cambio.' };
  }
  const eligible = snapshots
    .filter((s) => s.day <= fromDay && s.day < today && s.netWorthEur != null)
    .sort((a, b) => a.day.localeCompare(b.day));
  const base = eligible[eligible.length - 1];
  if (!base || base.netWorthEur == null) {
    return {
      available: false,
      amount: null,
      percent: null,
      baseDay: null,
      note: 'Aún no hay un patrimonio guardado al inicio de este periodo. El gráfico se irá rellenando con tus saldos reales.',
    };
  }
  const amount = roundMoney(todayValue - base.netWorthEur);
  const percent = base.netWorthEur === 0 ? null : roundMoney((amount / Math.abs(base.netWorthEur)) * 100, 2);
  return {
    available: true,
    amount,
    percent,
    baseDay: base.day,
    note: percent == null ? 'La variación en porcentaje no se calcula porque el patrimonio inicial era 0.' : `Respecto al ${base.day}.`,
  };
}

export function movementFingerprint(input: {
  accountId: string;
  type: string;
  date: string;
  amount: number;
  currency: string;
  description: string;
}): string {
  const desc = input.description.trim().toLowerCase().replace(/\s+/g, ' ');
  return [
    input.accountId,
    input.type,
    input.date.slice(0, 10),
    input.currency.trim().toUpperCase(),
    roundMoney(input.amount).toFixed(2),
    desc,
  ].join('|');
}

export function assertNoSecret(value: string): string | null {
  if (/private key|seed phrase|clave privada|frase semilla|mnemonic/i.test(value)) {
    return 'No guardamos frases semilla ni claves privadas.';
  }
  const words = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const looksLikeSeed = [12, 15, 18, 21, 24].includes(words.length) && words.every((word) => /^[a-z]{3,8}$/.test(word));
  if (looksLikeSeed) {
    return 'No guardamos frases semilla ni claves privadas. Escribe solo una dirección pública.';
  }
  return null;
}

export interface MovementDraft {
  type: MovementType;
  amount: number;
  accountId: string;
  counterAccountId?: string | null;
  holdingId?: string | null;
  quantity?: number | null;
  applyToBalances: boolean;
  direction?: 'in' | 'out';
}

export interface AppliedEffects {
  applied: boolean;
  accountDeltas: { accountId: string; amount: number }[];
  holding?: { holdingId: string; quantityDelta: number; costBasisDelta: number | null; clearMarket: boolean };
  costOfSold: number | null;
  warning?: string;
}

export interface Books {
  accounts: AccountSnap[];
  holdings: HoldingSnap[];
}

function cloneBooks(books: Books): Books {
  return {
    accounts: books.accounts.map((a) => ({ ...a })),
    holdings: books.holdings.map((h) => ({ ...h })),
  };
}

export function applyMovementToBooks(
  books: Books,
  movement: MovementDraft,
): { books: Books; effects: AppliedEffects } | { error: string } {
  if (!(movement.amount > 0) || !Number.isFinite(movement.amount)) return { error: 'El importe tiene que ser mayor que cero.' };
  const next = cloneBooks(books);
  const primary = next.accounts.find((a) => a.id === movement.accountId);
  if (!primary) return { error: 'La cuenta no existe.' };

  if (!movement.applyToBalances) {
    return {
      books: next,
      effects: { applied: false, accountDeltas: [], costOfSold: null },
    };
  }

  const deltas: { accountId: string; amount: number }[] = [];
  const touch = (account: AccountSnap, delta: number) => {
    account.balance = roundMoney(account.balance + delta);
    deltas.push({ accountId: account.id, amount: roundMoney(delta) });
  };

  if (movement.type === 'transfer') {
    if (!movement.counterAccountId) return { error: 'Una transferencia necesita cuenta de destino.' };
    if (movement.counterAccountId === movement.accountId) return { error: 'El origen y el destino tienen que ser distintos.' };
    const counter = next.accounts.find((a) => a.id === movement.counterAccountId);
    if (!counter) return { error: 'La cuenta de destino no existe.' };
    if (counter.currency.toUpperCase() !== primary.currency.toUpperCase()) {
      return { error: 'Entre monedas distintas no muevo el saldo solo: no hay un tipo de cambio automático. Registra cada pata con su importe o indica el tipo manual en un ajuste.' };
    }
    touch(primary, -movement.amount);
    touch(counter, movement.amount);
    return { books: next, effects: { applied: true, accountDeltas: deltas, costOfSold: null } };
  }

  if (movement.type === 'buy' || movement.type === 'sell') {
    if (!movement.holdingId) return { error: 'Indica el activo de la compra o la venta.' };
    const holding = next.holdings.find((h) => h.id === movement.holdingId);
    if (!holding || holding.accountId !== primary.id) return { error: 'El activo no está en esa cuenta.' };
    const qty = movement.quantity ?? 0;
    if (!(qty > 0)) return { error: 'Indica la cantidad del activo.' };
    if (holding.currency.toUpperCase() !== primary.currency.toUpperCase()) {
      return { error: 'La cuenta y el activo tienen monedas distintas. Unifica la moneda o deja el saldo sin actualizar automático.' };
    }

    if (movement.type === 'buy') {
      touch(primary, -movement.amount);
      const wasEmpty = holding.quantity <= 0 && holding.costBasis == null;
      holding.quantity = roundQty(holding.quantity + qty);
      let costDelta: number | null = null;
      if (wasEmpty || holding.costBasis != null) {
        costDelta = roundMoney(movement.amount);
        holding.costBasis = roundMoney((holding.costBasis ?? 0) + movement.amount);
      }
      return {
        books: next,
        effects: {
          applied: true,
          accountDeltas: deltas,
          holding: { holdingId: holding.id, quantityDelta: roundQty(qty), costBasisDelta: costDelta, clearMarket: false },
          costOfSold: null,
        },
      };
    }

    if (qty - holding.quantity > 1e-8) return { error: 'No puedes vender más cantidad de la que tienes registrada.' };
    const ratio = holding.quantity > 0 ? qty / holding.quantity : 0;
    const costOfSold = holding.costBasis == null ? null : roundMoney(holding.costBasis * ratio);
    if (holding.costBasis != null && costOfSold != null) holding.costBasis = roundMoney(holding.costBasis - costOfSold);
    holding.quantity = roundQty(holding.quantity - qty);
    touch(primary, movement.amount);
    return {
      books: next,
      effects: {
        applied: true,
        accountDeltas: deltas,
        holding: {
          holdingId: holding.id,
          quantityDelta: roundQty(-qty),
          costBasisDelta: costOfSold == null ? null : roundMoney(-costOfSold),
          clearMarket: false,
        },
        costOfSold,
        warning: costOfSold == null ? 'Venta registrada sin coste de adquisición: la ganancia realizada queda incompleta.' : undefined,
      },
    };
  }

  let sign = cashSign(movement.type);
  if (movement.type === 'adjustment') {
    if (movement.direction !== 'in' && movement.direction !== 'out') return { error: 'El ajuste tiene que decir si el saldo sube o baja.' };
    sign = movement.direction === 'in' ? 1 : -1;
  }
  if (sign === 0) return { error: 'Ese tipo de movimiento no se puede aplicar al saldo.' };
  touch(primary, sign * movement.amount);
  return { books: next, effects: { applied: true, accountDeltas: deltas, costOfSold: null } };
}

export function revertEffects(books: Books, effects: AppliedEffects): Books | { error: string } {
  if (!effects.applied) return cloneBooks(books);
  const next = cloneBooks(books);
  for (const delta of effects.accountDeltas) {
    const account = next.accounts.find((a) => a.id === delta.accountId);
    if (!account) return { error: 'No se puede deshacer: falta una cuenta.' };
    account.balance = roundMoney(account.balance - delta.amount);
  }
  if (effects.holding) {
    const holding = next.holdings.find((h) => h.id === effects.holding!.holdingId);
    if (!holding) return { error: 'No se puede deshacer: falta el activo.' };
    holding.quantity = roundQty(holding.quantity - effects.holding.quantityDelta);
    if (holding.quantity < -1e-8) return { error: 'No se puede deshacer porque el activo ya no tiene esa cantidad.' };
    if (holding.quantity < 0) holding.quantity = 0;
    if (effects.holding.costBasisDelta != null && holding.costBasis != null) {
      holding.costBasis = roundMoney(holding.costBasis - effects.holding.costBasisDelta);
    }
  }
  return next;
}

export interface PlanEvent {
  id?: string;
  name?: string;
  amount: number;
  date: string;
  status?: 'expected' | 'confirmed';
  paid?: boolean;
  /** El día elegido se apunta solo, sin marca. */
  automatic?: boolean;
  /** Ya está dentro del efectivo de la cuenta: se enseña y no se vuelve a restar. */
  absorbed?: boolean;
}

export interface PlanRecurring {
  id?: string;
  name?: string;
  amount: number;
  dayOfMonth: number;
  paidDates?: string[];
  direction?: 'in' | 'out';
}

export interface PlanInterval {
  id?: string;
  name?: string;
  amount: number;
  everyWeeks: number;
  startDate: string;
  paidDates?: string[];
  direction?: 'in' | 'out';
}

export interface PlanScenario {
  id: string;
  name: string;
  monthlySavings: number;
}

export interface SavingsPlanInput {
  openingBalance: number;
  startDate: string;
  targetAmount: number;
  targetDate: string;
  monthlySavings: number;
  salary?: number;
  savingsDay?: number | null;
  recurring: PlanRecurring[];
  plannedExpenses: PlanEvent[];
  savingsPaid?: string[];
  savingsSkipped?: string[];
  savingsAdjustments?: { date: string; amount: number; name?: string }[];
  recurring: PlanRecurring[];
  intervals?: PlanInterval[];
  plannedExpenses: PlanEvent[];
  incomes: PlanEvent[];
  scenarios?: PlanScenario[];
  /** Si viene informado, un fijo solo cuenta cuando la persona lo ha confirmado. */
  settled?: { key: string; done: boolean; amount: number }[];
  /** Los fijos de este día o anteriores ya están dentro del efectivo. */
  includedUntil?: string;
}

export interface PlanMonthLine {
  label: string;
  tone: 'plain' | 'in' | 'out' | 'final';
  /** null en las filas de saldo: se enseña el balance, no un movimiento. */
  amount: number | null;
  balance: number;
  markKey?: string;
  paid?: boolean;
  automatic?: boolean;
  absorbed?: boolean;
  day?: string;
}

export interface PlanMonthView {
  month: string;
  title: string;
  lines: PlanMonthLine[];
}

export interface PlanForecast {
  plannedToday: number;
  plannedWithExpectedToday: number;
  /** Saldo previsto al cierre de ayer, con los ingresos estimados. Sirve para ver si hoy sube o baja. */
  balanceYesterday: number;
  deviationEur: number;
  compliancePct: number | null;
  onTrack: boolean;
  estimatedDate: string | null;
  estimatedDateWithExpected: string | null;
  extraMonthlyToRecover: number | null;
  gapAtTarget: number;
  savingsEventsRemaining: number;
  series: { month: string; planned: number; withExpected: number }[];
  months: PlanMonthView[];
  scenarios: { id: string; name: string; estimatedDate: string | null; balanceAtTarget: number }[];
  notes: string[];
}

function parseDay(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

export function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const dt = parseDay(iso);
  dt.setUTCDate(dt.getUTCDate() + n);
  return formatDay(dt);
}

export function todayKey(timeZone = 'Europe/Madrid', date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function dayOfMonth(iso: string): number {
  return Number(iso.slice(8, 10));
}

function lastDayOfMonth(iso: string): number {
  const dt = parseDay(iso.slice(0, 7) + '-01');
  dt.setUTCMonth(dt.getUTCMonth() + 1);
  dt.setUTCDate(0);
  return dt.getUTCDate();
}

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function monthTitle(month: string): string {
  const index = Number(month.slice(5, 7)) - 1;
  const name = MONTH_NAMES[index] || month;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${month.slice(0, 4)}`;
}

function monthName(iso: string): string {
  return MONTH_NAMES[Number(iso.slice(5, 7)) - 1] || iso.slice(0, 7);
}

function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000);
}

function intervalHits(item: PlanInterval, day: string): boolean {
  const start = item.startDate.slice(0, 10);
  if (day < start || !(item.amount > 0)) return false;
  const every = Math.max(1, Math.round(item.everyWeeks || 1));
  return daysBetween(start, day) % (every * 7) === 0;
}

function savingsAnchor(plan: SavingsPlanInput): number {
  const day = plan.savingsDay;
  if (day != null && Number.isFinite(day) && day >= 1 && day <= 31) return Math.round(day);
  return dayOfMonth(plan.startDate);
}

interface LedgerEvent {
  day: string;
  label: string;
  delta: number;
  tone: 'in' | 'out';
  markKey?: string;
  paid?: boolean;
  automatic?: boolean;
  absorbed?: boolean;
}

function confirmed(plan: SavingsPlanInput, key: string | undefined): { key: string; done: boolean; amount: number } | undefined {
  if (!key) return undefined;
  return plan.settled?.find((item) => item.key === key);
}

/**
 * La marca del usuario manda: savingsPaid, paidDates o la confirmación.
 * Sin esa lista, un fijo entra solo al llegar su día.
 */
function fixedPaid(plan: SavingsPlanInput, key: string | undefined, day: string, today: string, dates?: string[]): boolean {
  if (dates?.includes(day)) return true;
  if (key?.startsWith('savings:') && plan.savingsPaid?.includes(day)) return true;
  if (!plan.settled) return day <= today;
  return confirmed(plan, key)?.done === true;
}

/** Ya está dentro del efectivo: el propio apunte, una confirmación de ese día, o un fijo anterior a la última actualización. Un gasto suelto no. */
function fixedAbsorbed(plan: SavingsPlanInput, key: string | undefined, day: string, explicit = false, automatic = false): boolean {
  if (explicit) return true;
  if (!plan.includedUntil || day > plan.includedUntil) return false;
  if (confirmed(plan, key)?.done === true) return true;
  return automatic;
}

function ledgerEvents(plan: SavingsPlanInput, fromDay: string, endDay: string, today: string): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  for (let day = fromDay; day <= endDay; day = addDays(day, 1)) {
    const dim = lastDayOfMonth(day);
    const dueSavings = Math.min(savingsAnchor(plan), dim);
    if (day > plan.startDate && dayOfMonth(day) === dueSavings && plan.monthlySavings > 0 && !plan.savingsSkipped?.includes(day)) {
      const adjustment = plan.savingsAdjustments?.find((item) => item.date.slice(0, 10) === day);
      const markKey = `savings:${day}`;
      const row = confirmed(plan, markKey);
      const amount = row?.done && row.amount > 0 ? row.amount : adjustment && adjustment.amount > 0 ? adjustment.amount : plan.monthlySavings;
      const custom = adjustment?.name?.trim();
      const absorbed = fixedAbsorbed(plan, markKey, day, false, true);
      events.push({
        day,
        label: custom || ((plan.salary || 0) > 0 ? 'Nómina · parte ahorro' : `Ahorro del ${dayOfMonth(day)} de ${monthName(day)}`),
        delta: amount,
        tone: 'in',
        markKey,
        paid: absorbed || fixedPaid(plan, markKey, day, today),
        automatic: true,
        absorbed,
      });
    }
    if (day < plan.startDate) continue;
    for (const item of plan.recurring) {
      const due = Math.min(Math.max(1, item.dayOfMonth), dim);
      if (dayOfMonth(day) === due && item.amount > 0) {
        const incoming = item.direction === 'in';
        const markKey = item.id ? `recurring:${item.id}:${day}` : undefined;
        const row = confirmed(plan, markKey);
        const amount = row?.done && row.amount > 0 ? row.amount : item.amount;
        const absorbed = fixedAbsorbed(plan, markKey, day, false, true);
        events.push({
          day,
          label: item.name?.trim() || (incoming ? 'Entrada fija' : 'Gasto fijo'),
          delta: incoming ? amount : -amount,
          tone: incoming ? 'in' : 'out',
          markKey,
          paid: absorbed || fixedPaid(plan, markKey, day, today, item.paidDates),
          automatic: true,
          absorbed,
        });
      }
    }
    for (const item of plan.intervals ?? []) {
      if (!intervalHits(item, day)) continue;
      const weeks = Math.max(1, Math.round(item.everyWeeks || 1));
      const incoming = item.direction === 'in';
      const markKey = item.id ? `interval:${item.id}:${day}` : undefined;
      const row = confirmed(plan, markKey);
      const amount = row?.done && row.amount > 0 ? row.amount : item.amount;
      const absorbed = fixedAbsorbed(plan, markKey, day, false, true);
      events.push({
        day,
        label: `${item.name?.trim() || (incoming ? 'Entrada fija' : 'Gasto fijo')} · cada ${weeks} ${weeks === 1 ? 'semana' : 'semanas'}`,
        delta: incoming ? amount : -amount,
        tone: incoming ? 'in' : 'out',
        markKey,
        paid: absorbed || fixedPaid(plan, markKey, day, today, item.paidDates),
        automatic: true,
        absorbed,
      });
    }
    for (const expense of plan.plannedExpenses) {
      if (expense.date.slice(0, 10) === day && expense.amount > 0) {
        const automatic = expense.automatic === true;
        const markKey = expense.id ? `expense:${expense.id}` : undefined;
        const row = confirmed(plan, markKey);
        const amount = automatic && row?.done && row.amount > 0 ? row.amount : expense.amount;
        const absorbed = fixedAbsorbed(plan, markKey, day, expense.absorbed === true, automatic);
        events.push({
          day,
          label: expense.name?.trim() || 'Gasto',
          delta: -amount,
          tone: 'out',
          markKey,
          paid: absorbed || expense.paid === true || (automatic && fixedPaid(plan, markKey, day, today)),
          automatic,
          absorbed,
        });
      }
    }
    for (const income of plan.incomes) {
      if (income.date.slice(0, 10) !== day || !(income.amount > 0)) continue;
      const estimated = income.status === 'expected';
      const name = income.name?.trim() || 'Ingreso';
      const automatic = income.automatic === true;
      events.push({
        day,
        label: estimated ? `${name} (estimado)` : name,
        delta: income.amount,
        tone: 'in',
        markKey: income.id ? `income:${income.id}` : undefined,
        paid: income.paid === true || (automatic && fixedPaid(plan, income.id ? `income:${income.id}` : undefined, day, today)),
        automatic,
      });
    }
  }
  return events;
}

/** Mes a mes, con los mismos días que la simulación. Como máximo 60 meses. */
export function planMonths(plan: SavingsPlanInput, today = todayKey()): PlanMonthView[] {
  const end = plan.targetDate >= plan.startDate ? plan.targetDate : plan.startDate;
  const capped = addDays(plan.startDate, 31 * 60);
  const last = end < capped ? end : capped;
  const events = ledgerEvents(plan, plan.startDate, last, today);
  const views: PlanMonthView[] = [];
  let balance = roundMoney(plan.openingBalance);
  // El saldo solo se mueve con lo ya contado: el fijo cuando llega su día, el extra cuando está marcado.
  let cursor = plan.startDate.slice(0, 7);
  const stop = last.slice(0, 7);
  let guard = 0;
  while (cursor <= stop && guard < 61) {
    guard += 1;
    const inMonth = events.filter((event) => monthKey(event.day) === cursor);
    const lines: PlanMonthLine[] = [];
    for (const event of inMonth.filter((item) => item.absorbed)) {
      lines.push({
        label: event.label,
        tone: event.tone,
        amount: event.delta,
        balance,
        markKey: event.markKey,
        paid: event.paid === true,
        automatic: event.automatic,
        absorbed: true,
        day: event.day,
      });
    }
    const pending = inMonth.filter((item) => !item.absorbed);
    lines.push({ label: views.length === 0 ? 'Saldo actual' : 'Saldo inicial', tone: 'plain', amount: null, balance });
    let outsBeforeIn = 0;
    let lastOut = '';
    let checkpointed = false;
    for (const event of pending) {
      const counts = event.paid === true;
      if (!checkpointed && outsBeforeIn > 0 && (!counts || event.tone === 'in')) {
        lines.push({
          label: outsBeforeIn === 1 ? `Saldo tras ${lastOut}` : 'Saldo tras las compras',
          tone: 'plain',
          amount: null,
          balance,
        });
        checkpointed = true;
      }
      if (counts) balance = roundMoney(balance + event.delta);
      lines.push({
        label: event.label,
        tone: event.tone,
        amount: event.delta,
        balance,
        markKey: event.markKey,
        paid: event.paid,
        automatic: event.automatic,
        day: event.day,
      });
      if (!checkpointed && counts && event.tone === 'out') {
        outsBeforeIn += 1;
        lastOut = event.label;
      }
    }
    lines.push({ label: `Saldo final de ${monthName(cursor + '-01')}`, tone: 'final', amount: null, balance });
    views.push({ month: cursor, title: monthTitle(cursor), lines });
    const [year, month] = cursor.split('-').map(Number);
    const next = new Date(Date.UTC(year, month, 1));
    cursor = next.toISOString().slice(0, 7);
  }
  return views;
}

/** Saldo del plan con lo ya marcado, aunque la fecha del apunte sea posterior a hoy. */
export function balanceMarked(months: PlanMonthView[], day: string, opening: number): number {
  let balance = opening;
  for (const month of months) {
    for (const line of month.lines) {
      if (!line.day) continue;
      if (line.day <= day || line.paid) balance = line.balance;
    }
  }
  return balance;
}

interface SimOptions {
  monthlySavings: number;
  includeExpected: boolean;
  stopWhenHit?: boolean;
}

function eventAmount(events: PlanEvent[], day: string, includeExpected: boolean): number {
  let total = 0;
  for (const event of events) {
    if (event.date.slice(0, 10) !== day) continue;
    if (event.status === 'expected' && !includeExpected) continue;
    total += event.amount;
  }
  return total;
}

/** Recorre días y devuelve el saldo al final de `end`, y el primer día en que llega al objetivo. */
function walk(
  plan: SavingsPlanInput,
  startBalance: number,
  fromDay: string,
  endDay: string,
  options: SimOptions,
  target: number | null,
): { endBalance: number; hit: string | null; savingsEvents: number; monthEnds: Map<string, number> } {
  let balance = startBalance;
  let hit: string | null = target != null && balance >= target ? fromDay : null;
  let savingsEvents = 0;
  const monthEnds = new Map<string, number>();
  // El primer ahorro no cae el mismo día de inicio: el saldo inicial ya es el punto de partida.
  const firstSavings = plan.startDate;

  for (let day = fromDay; day <= endDay; day = addDays(day, 1)) {
    const dim = lastDayOfMonth(day);
    const recurringDay = Math.min(savingsAnchor(plan), dim);
    if (day > firstSavings && dayOfMonth(day) === recurringDay && !plan.savingsSkipped?.includes(day)) {
      const row = confirmed(plan, `savings:${day}`);
      const inside = Boolean(plan.includedUntil && day <= plan.includedUntil && row?.done !== false);
      if (!inside) {
        balance = roundMoney(balance + (row?.done && row.amount > 0 ? row.amount : options.monthlySavings));
        savingsEvents += 1;
      }
    }
    for (const item of plan.recurring) {
      const due = Math.min(Math.max(1, item.dayOfMonth), dim);
      const key = item.id ? `recurring:${item.id}:${day}` : '';
      const row = confirmed(plan, key);
      const inside = Boolean(key && plan.includedUntil && day <= plan.includedUntil && row?.done !== false);
      if (day >= plan.startDate && dayOfMonth(day) === due && row?.done !== false && !inside) {
        const amount = row?.done && row.amount > 0 ? row.amount : item.amount;
        balance = roundMoney(balance + (item.direction === 'in' ? amount : -amount));
      }
    }
    if (day >= plan.startDate) {
      for (const item of plan.intervals ?? []) {
        const key = item.id ? `interval:${item.id}:${day}` : '';
        const row = confirmed(plan, key);
        const inside = Boolean(key && plan.includedUntil && day <= plan.includedUntil && row?.done !== false);
        if (intervalHits(item, day) && row?.done !== false && !inside) {
          const amount = row?.done && row.amount > 0 ? row.amount : item.amount;
          balance = roundMoney(balance + (item.direction === 'in' ? amount : -amount));
        }
      }
    }
    if (day >= plan.startDate) {
      for (const expense of plan.plannedExpenses) {
        if (expense.absorbed) continue;
        const key = expense.id ? `expense:${expense.id}` : '';
        if (key && confirmed(plan, key)?.done === false) continue;
        if (expense.date.slice(0, 10) === day) {
          const row = confirmed(plan, key);
          const amount = row?.done && row.amount > 0 ? row.amount : expense.amount;
          balance = roundMoney(balance - amount);
        }
      }
      balance = roundMoney(balance + eventAmount(plan.incomes, day, options.includeExpected));
    }
    if (hit == null && target != null && balance >= target) hit = day;
    if (hit && options.stopWhenHit) {
      monthEnds.set(monthKey(day), balance);
      break;
    }
    const next = addDays(day, 1);
    if (monthKey(next) !== monthKey(day) || day === endDay) monthEnds.set(monthKey(day), balance);
    if (day === endDay) break;
  }
  return { endBalance: balance, hit, savingsEvents, monthEnds };
}

const HORIZON_DAYS = 366 * 40;

export function forecastPlan(plan: SavingsPlanInput, realBalance: number | null, today: string): PlanForecast {
  const notes: string[] = [];
  notes.push('Los ingresos esperados no forman parte del patrimonio real hasta que los registres como recibidos.');

  const confirmed = walk(plan, plan.openingBalance, plan.startDate, today, { monthlySavings: plan.monthlySavings, includeExpected: false }, null);
  const withExpected = walk(plan, plan.openingBalance, plan.startDate, today, { monthlySavings: plan.monthlySavings, includeExpected: true }, null);

  const plannedToday = confirmed.endBalance;
  const plannedWithExpectedToday = withExpected.endBalance;
  const yesterday = addDays(today, -1);
  const balanceYesterday =
    yesterday < plan.startDate
      ? roundMoney(plan.openingBalance)
      : walk(plan, plan.openingBalance, plan.startDate, yesterday, { monthlySavings: plan.monthlySavings, includeExpected: true }, null).endBalance;
  const real = realBalance;
  const deviationEur = real == null ? 0 : roundMoney(real - plannedToday);
  const compliancePct = real == null || plannedToday === 0 ? null : roundMoney((real / plannedToday) * 100, 1);
  const onTrack = real != null && deviationEur >= -0.009;

  if (real == null) notes.push('Este plan no tiene saldo real vinculado. La desviación no se puede calcular.');

  const tomorrow = addDays(today, 1);
  const targetStillAhead = plan.targetDate >= tomorrow;
  const baseForward =
    real == null || !targetStillAhead
      ? null
      : walk(plan, real, tomorrow, plan.targetDate, { monthlySavings: plan.monthlySavings, includeExpected: false }, null);

  let extraMonthlyToRecover: number | null = null;
  let gapAtTarget = 0;
  let savingsEventsRemaining = 0;
  if (real != null && !targetStillAhead) {
    gapAtTarget = roundMoney(plan.targetAmount - real);
    notes.push('La fecha objetivo ya ha pasado.');
  } else if (baseForward && real != null) {
    gapAtTarget = roundMoney(plan.targetAmount - baseForward.endBalance);
    savingsEventsRemaining = baseForward.savingsEvents;
    if (gapAtTarget <= 0) extraMonthlyToRecover = 0;
    else if (savingsEventsRemaining > 0) extraMonthlyToRecover = roundMoney(gapAtTarget / savingsEventsRemaining);
    else notes.push('No queda ningún ahorro mensual antes de la fecha objetivo. Con el ritmo actual esa fecha no se recupera.');
  }

  const searchEnd = addDays(today, HORIZON_DAYS);
  const estimated =
    real == null
      ? null
      : real >= plan.targetAmount
        ? { hit: today }
        : walk(plan, real, tomorrow, searchEnd, { monthlySavings: plan.monthlySavings, includeExpected: false, stopWhenHit: true }, plan.targetAmount);
  const estimatedExpected =
    real == null
      ? null
      : real >= plan.targetAmount
        ? { hit: today }
        : walk(plan, real, tomorrow, searchEnd, { monthlySavings: plan.monthlySavings, includeExpected: true, stopWhenHit: true }, plan.targetAmount);

  if (estimated && estimated.hit == null && real != null && real < plan.targetAmount) {
    notes.push('Con el ahorro y los gastos confirmados, el objetivo no se alcanza en 40 años.');
  }

  const seriesEnd = plan.targetDate > today ? plan.targetDate : today;
  const seriesWalk = walk(plan, plan.openingBalance, plan.startDate, seriesEnd, { monthlySavings: plan.monthlySavings, includeExpected: false }, null);
  const seriesExpected = walk(plan, plan.openingBalance, plan.startDate, seriesEnd, { monthlySavings: plan.monthlySavings, includeExpected: true }, null);
  const months = new Set([...seriesWalk.monthEnds.keys(), ...seriesExpected.monthEnds.keys()]);
  const series = [...months].sort().map((month) => ({
    month,
    planned: seriesWalk.monthEnds.get(month) ?? plannedToday,
    withExpected: seriesExpected.monthEnds.get(month) ?? plannedWithExpectedToday,
  }));

  const scenarios = (plan.scenarios ?? []).map((scenario) => {
    const atTarget =
      real == null
        ? { endBalance: 0, hit: null, savingsEvents: 0, monthEnds: new Map<string, number>() }
        : !targetStillAhead
          ? { endBalance: real, hit: null, savingsEvents: 0, monthEnds: new Map<string, number>() }
          : walk(plan, real, tomorrow, plan.targetDate, { monthlySavings: scenario.monthlySavings, includeExpected: false }, null);
    const found =
      real == null
        ? null
        : real >= plan.targetAmount
          ? { hit: today }
          : walk(plan, real, tomorrow, searchEnd, { monthlySavings: scenario.monthlySavings, includeExpected: false, stopWhenHit: true }, plan.targetAmount);
    return {
      id: scenario.id,
      name: scenario.name,
      estimatedDate: found?.hit ?? null,
      balanceAtTarget: atTarget.endBalance,
    };
  });

  return {
    plannedToday,
    plannedWithExpectedToday,
    balanceYesterday,
    deviationEur: real == null ? 0 : deviationEur,
    compliancePct,
    onTrack,
    estimatedDate: estimated?.hit ?? null,
    estimatedDateWithExpected: estimatedExpected?.hit ?? null,
    extraMonthlyToRecover,
    gapAtTarget,
    savingsEventsRemaining,
    series,
    months: planMonths(plan, today),
    scenarios,
    notes,
  };
}

export function pnlSlices(accounts: AccountSnap[], holdings: HoldingSnap[]): PnlSlice[] {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const slices: PnlSlice[] = [];
  for (const holding of holdings) {
    const account = byId.get(holding.accountId);
    if (!account || account.tracking !== 'positions' || holding.quantity <= 0) continue;
    const gross = positionValue(holding);
    const market = gross == null ? null : toEur(gross, holding.currency, holding.eurPerUnit);
    const cost = holding.costBasis == null ? null : toEur(holding.costBasis, holding.currency, holding.eurPerUnit);
    const eur = market?.ok && market.eur != null && cost?.ok && cost.eur != null ? roundMoney(market.eur - cost.eur) : null;
    slices.push({ key: holding.id, label: holding.name || 'Activo', accountId: account.id, eur });
  }
  return slices;
}

export interface ExtraSnap {
  id: string;
  place: string;
  name: string;
  valueEur: number;
  costEur: number | null;
  track?: boolean;
}

export function summarizeExtras(items: ExtraSnap[]): {
  total: number;
  allocation: AllocationSlice | null;
  pnl: { key: string; label: string; eur: number | null; accountName: string; platform: string; place: string }[];
} {
  const total = roundMoney(items.reduce((sum, item) => sum + (Number.isFinite(item.valueEur) ? item.valueEur : 0), 0));
  return {
    total,
    allocation: total > 0 ? { key: 'extra', label: 'Extra', eur: total } : null,
    pnl: items.map((item) => ({
      key: `extra:${item.id}`,
      label: item.name,
      eur: item.track === false || item.costEur == null || !Number.isFinite(item.costEur) ? null : roundMoney(item.valueEur - item.costEur),
      accountName: item.name,
      platform: item.place,
      place: item.place,
    })),
  };
}

export function allocationSlices(portfolio: Portfolio): AllocationSlice[] {
  const groups: Record<string, { label: string; eur: number }> = {
    available: { label: 'Disponible', eur: 0 },
    invested: { label: 'Invertido', eur: 0 },
    crypto: { label: 'Criptomonedas', eur: 0 },
    personal: { label: 'Bienes', eur: 0 },
  };
  for (const line of portfolio.lines) {
    if (line.eur == null || line.eur === 0 || line.bucket === 'excluded') continue;
    groups[line.bucket].eur = roundMoney(groups[line.bucket].eur + line.eur);
  }
  return Object.entries(groups)
    .filter(([, g]) => g.eur > 0)
    .map(([key, g]) => ({ key, label: g.label, eur: g.eur }));
}
