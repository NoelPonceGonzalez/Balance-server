import mongoose from 'mongoose';
import { Account } from '../models/Account.js';
import { Extra } from '../models/Extra.js';
import { Holding } from '../models/Holding.js';
import { Movement } from '../models/Movement.js';
import { Plan } from '../models/Plan.js';
import { Wallet } from '../models/Wallet.js';
import { remindDuePayments } from './plan-reminders.js';
import { Snapshot } from '../models/Snapshot.js';
import { HttpError } from '../http.js';
import { User } from '../models/User.js';
import {
  addDays,
  allocationSlices,
  analyzeMovements,
  applyMovementToBooks,
  forecastPlan,
  movementFingerprint,
  planMonths,
  balanceMarked,
  pnlSlices,
  roundMoney,
  summarizeExtras,
  revertEffects,
  todayKey,
  valuePortfolio,
  variationFromSnapshots,
  type AccountSnap,
  type AppliedEffects,
  type Books,
  type HoldingSnap,
  type MovementDraft,
  type MovementSnap,
  type MovementType,
} from '../domain/finance.js';

type Session = mongoose.ClientSession;

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

async function withTransaction<T>(fn: (session: Session) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function snapAccount(doc: {
  _id: unknown;
  name: string;
  kind: AccountSnap['kind'];
  tracking: AccountSnap['tracking'];
  currency: string;
  balance: number;
  eurPerUnit?: number | null;
  balanceUpdatedAt?: Date | null;
}): AccountSnap {
  return {
    id: String(doc._id),
    name: doc.name,
    kind: doc.kind,
    tracking: doc.tracking,
    currency: doc.currency,
    balance: doc.balance,
    eurPerUnit: doc.currency === 'EUR' ? null : (doc.eurPerUnit ?? null),
    updatedAt: doc.balanceUpdatedAt ? new Date(doc.balanceUpdatedAt).toISOString() : null,
  };
}

function snapHolding(doc: {
  _id: unknown;
  accountId: unknown;
  name: string;
  assetClass: HoldingSnap['assetClass'];
  currency: string;
  quantity: number;
  unitMarketValue?: number | null;
  costBasis?: number | null;
  eurPerUnit?: number | null;
  valuedAt?: Date | null;
  priceSource?: 'manual' | 'market' | null;
}): HoldingSnap {
  return {
    id: String(doc._id),
    accountId: String(doc.accountId),
    name: doc.name,
    assetClass: doc.assetClass,
    currency: doc.currency,
    quantity: doc.quantity,
    unitMarketValue: doc.unitMarketValue ?? null,
    priceSource: doc.priceSource === 'market' ? 'market' : 'manual',
    costBasis: doc.costBasis ?? null,
    eurPerUnit: doc.currency === 'EUR' ? null : (doc.eurPerUnit ?? null),
    valuedAt: doc.valuedAt ? new Date(doc.valuedAt).toISOString() : null,
  };
}

async function loadBooks(userId: string, session?: Session, includeArchived = false): Promise<Books> {
  const accountQuery = includeArchived ? { userId } : { userId, archived: { $ne: true } };
  const accounts = await Account.find(accountQuery).session(session ?? null);
  const ids = new Set(accounts.map((account) => String(account._id)));
  const holdings = await Holding.find({ userId, accountId: { $in: [...ids] } }).session(session ?? null);
  return { accounts: accounts.map(snapAccount), holdings: holdings.map(snapHolding) };
}

async function persistBooks(userId: string, before: Books, after: Books, session: Session) {
  const now = new Date();
  for (const account of after.accounts) {
    const prev = before.accounts.find((item) => item.id === account.id);
    if (!prev || prev.balance !== account.balance) {
      await Account.updateOne({ _id: account.id, userId }, { $set: { balance: account.balance, balanceUpdatedAt: now } }).session(session);
    }
  }
  for (const holding of after.holdings) {
    const prev = before.holdings.find((item) => item.id === holding.id);
    if (!prev || prev.quantity !== holding.quantity || prev.costBasis !== holding.costBasis) {
      await Holding.updateOne(
        { _id: holding.id, userId },
        { $set: { quantity: holding.quantity, costBasis: holding.costBasis } },
      ).session(session);
    }
  }
}

function readEffects(raw: unknown): AppliedEffects {
  const value = (raw ?? {}) as Partial<AppliedEffects>;
  return {
    applied: Boolean(value.applied),
    accountDeltas: Array.isArray(value.accountDeltas)
      ? value.accountDeltas.map((delta) => ({ accountId: String(delta.accountId), amount: Number(delta.amount) }))
      : [],
    holding: value.holding
      ? {
          holdingId: String(value.holding.holdingId),
          quantityDelta: Number(value.holding.quantityDelta),
          costBasisDelta: value.holding.costBasisDelta == null ? null : Number(value.holding.costBasisDelta),
          clearMarket: false,
        }
      : undefined,
    costOfSold: value.costOfSold == null ? null : Number(value.costOfSold),
  };
}

export interface MovementInput {
  type: MovementType;
  date: string;
  amount: number;
  currency: string;
  eurPerUnit?: number | null;
  category?: string;
  description?: string;
  accountId: string;
  counterAccountId?: string | null;
  holdingId?: string | null;
  quantity?: number | null;
  direction?: 'in' | 'out';
  fee?: number | null;
  applyToBalances: boolean;
  confirmDuplicate?: boolean;
}

function draftOf(input: MovementInput): MovementDraft {
  return {
    type: input.type,
    amount: input.amount,
    accountId: input.accountId,
    counterAccountId: input.counterAccountId,
    holdingId: input.holdingId,
    quantity: input.quantity,
    applyToBalances: input.applyToBalances,
    direction: input.direction,
  };
}

function assertCurrency(books: Books, input: MovementInput) {
  if (!input.applyToBalances) return;
  const account = books.accounts.find((item) => item.id === input.accountId);
  if (!account) throw new HttpError(400, 'La cuenta no existe.');
  if (account.currency.toUpperCase() !== input.currency.toUpperCase()) {
    throw new HttpError(400, 'La moneda del movimiento no coincide con la de la cuenta.');
  }
}

async function timezoneOf(userId: string): Promise<string> {
  const user = await User.findById(userId).select('timezone');
  return user?.timezone || 'Europe/Madrid';
}

export async function recordSnapshot(userId: string) {
  const books = await loadBooks(userId);
  const portfolio = valuePortfolio(books.accounts, books.holdings);
  const valuedEur = portfolio.netWorth.eur;
  const day = todayKey(await timezoneOf(userId));
  await Snapshot.updateOne(
    { userId, day },
    {
      $set: {
        valuedEur,
        netWorthEur: portfolio.netWorth.complete ? valuedEur : null,
        complete: portfolio.netWorth.complete,
        availableEur: portfolio.available.eur,
        investedEur: portfolio.invested.eur,
        cryptoEur: portfolio.crypto.eur,
      },
    },
    { upsert: true },
  );
  return { day, portfolio };
}

export async function createMovement(userId: string, input: MovementInput) {
  const saved = await withTransaction(async (session) => {
    const books = await loadBooks(userId, session);
    assertCurrency(books, input);
    const fingerprint = movementFingerprint({
      accountId: input.accountId,
      type: input.type,
      date: input.date,
      amount: input.amount,
      currency: input.currency,
      description: input.description || '',
    });
    const duplicate = await Movement.findOne({ userId, fingerprint }).session(session);
    if (duplicate && !input.confirmDuplicate) {
      throw new HttpError(409, 'Ya hay un movimiento con la misma cuenta, fecha, importe y descripción.', 'duplicate');
    }
    const applied = applyMovementToBooks(books, draftOf(input));
    if ('error' in applied) throw new HttpError(400, applied.error);
    await persistBooks(userId, books, applied.books, session);
    const [doc] = await Movement.create(
      [
        {
          userId,
          ...input,
          currency: input.currency.toUpperCase(),
          fingerprint,
          source: 'manual',
          effects: applied.effects,
        },
      ],
      { session },
    );
    return { id: String(doc._id), warning: applied.effects.warning || null };
  });
  await recordSnapshot(userId);
  return saved;
}

export async function updateMovement(userId: string, id: string, input: MovementInput) {
  const saved = await withTransaction(async (session) => {
    const current = await Movement.findOne({ _id: id, userId }).session(session);
    if (!current) throw new HttpError(404, 'Ese movimiento no existe.');
    const books = await loadBooks(userId, session, true);
    const reverted = revertEffects(books, readEffects(current.effects));
    if ('error' in reverted) throw new HttpError(400, reverted.error);
    assertCurrency(reverted, input);
    const applied = applyMovementToBooks(reverted, draftOf(input));
    if ('error' in applied) throw new HttpError(400, applied.error);
    await persistBooks(userId, books, applied.books, session);
    current.set({
      ...input,
      currency: input.currency.toUpperCase(),
      fingerprint: movementFingerprint({
        accountId: input.accountId,
        type: input.type,
        date: input.date,
        amount: input.amount,
        currency: input.currency,
        description: input.description || '',
      }),
      effects: applied.effects,
    });
    await current.save({ session });
    return { id, warning: applied.effects.warning || null };
  });
  await recordSnapshot(userId);
  return saved;
}

export async function deleteMovement(userId: string, id: string) {
  await withTransaction(async (session) => {
    const current = await Movement.findOne({ _id: id, userId }).session(session);
    if (!current) throw new HttpError(404, 'Ese movimiento no existe.');
    const books = await loadBooks(userId, session, true);
    const reverted = revertEffects(books, readEffects(current.effects));
    if ('error' in reverted) throw new HttpError(400, reverted.error);
    await persistBooks(userId, books, reverted, session);
    await current.deleteOne({ session });
  });
  await recordSnapshot(userId);
}

const PART_GROUP: Record<string, string> = {
  crypto: 'crypto',
  etf: 'etf',
  stock: 'stock',
  personal_good: 'personal_good',
  other: 'other',
};

function costInEur(holding: { costBasis?: number | null; currency: string; eurPerUnit?: number | null }): number | null {
  if (holding.costBasis == null || !Number.isFinite(holding.costBasis)) return null;
  if (holding.currency === 'EUR') return roundMoney(holding.costBasis);
  if (holding.eurPerUnit && holding.eurPerUnit > 0) return roundMoney(holding.costBasis * holding.eurPerUnit);
  return null;
}

function httpsImage(value?: string | null): string | null {
  return value && value.startsWith('https://') ? value : null;
}

function floatDetail(notes?: string | null): string {
  const match = (notes || '').match(/Float\s+(\d+\.\d+)/i);
  if (!match) return '';
  const rest = (notes || '')
    .slice((match.index ?? 0) + match[0].length)
    .replace(/^\.\s*/, '')
    .replace(/Paint\s+\d+\.?\s*/i, '')
    .replace(/Valor puesto a mano\.?/i, '')
    .trim()
    .replace(/\.$/, '');
  return rest ? `Float ${match[1]} · ${rest}` : `Float ${match[1]}`;
}

interface AccountMove {
  at: string;
  spentEur: number;
  quantity: number;
}

interface AccountPartRow {
  label: string;
  eur: number;
  group: string;
  costEur: number | null;
  detail: string;
  image: string | null;
  id: string | null;
  quantity: number;
  followMarket: boolean;
  quoteSource: string | null;
  quoteId: string | null;
  moves: AccountMove[];
}

function accountParts(
  account: { _id: unknown; tracking: string; balance: number; currency: string; eurPerUnit?: number | null },
  holdings: {
    _id?: unknown;
    accountId: unknown;
    name?: string;
    assetClass: string;
    quantity: number;
    unitMarketValue?: number | null;
    currency: string;
    eurPerUnit?: number | null;
    costBasis?: number | null;
    notes?: string | null;
    followMarket?: boolean | null;
    quoteImage?: string | null;
    quoteSource?: string | null;
    quoteId?: string | null;
    buys?: { at?: Date | string; spentEur?: number; quantity?: number }[];
  }[],
  valueEur: number | null,
): AccountPartRow[] {
  if (account.tracking !== 'positions') {
    return valueEur != null && valueEur > 0
      ? [{ label: 'Saldo', eur: valueEur, group: 'cash', costEur: null, detail: '', image: null, id: null, quantity: 0, followMarket: false, quoteSource: null, quoteId: null, moves: [] }]
      : [];
  }
  const parts: AccountPartRow[] = [];
  if (account.balance > 0 && (account.currency === 'EUR' || (account.eurPerUnit && account.eurPerUnit > 0))) {
    const liquid = account.currency === 'EUR' ? account.balance : account.balance * (account.eurPerUnit || 0);
    parts.push({ label: 'Líquido', eur: roundMoney(liquid), group: 'cash', costEur: null, detail: '', image: null, id: null, quantity: 0, followMarket: false, quoteSource: null, quoteId: null, moves: [] });
  }
  const grouped = new Map<string, AccountPartRow>();
  for (const holding of holdings) {
    if (String(holding.accountId) !== String(account._id) || !(holding.quantity > 0) || holding.unitMarketValue == null) continue;
    const native = holding.unitMarketValue * holding.quantity;
    const eur = holding.currency === 'EUR' ? native : holding.eurPerUnit && holding.eurPerUnit > 0 ? native * holding.eurPerUnit : null;
    if (eur == null) continue;
    const group = PART_GROUP[holding.assetClass] || 'other';
    const label = holding.name || 'Activo';
    const key = `${group}:${label}`;
    const cost = costInEur(holding);
    const image = httpsImage(holding.quoteImage);
    const moves = (holding.buys || []).flatMap((buy) => {
      const spent = typeof buy.spentEur === 'number' ? buy.spentEur : null;
      const at = buy.at ? new Date(buy.at).toISOString().slice(0, 10) : '';
      if (spent == null || !(spent > 0) || !at) return [];
      return [{ at, spentEur: roundMoney(spent), quantity: typeof buy.quantity === 'number' ? buy.quantity : 0 }];
    });
    const current = grouped.get(key);
    if (current) {
      current.eur = roundMoney(current.eur + eur);
      current.costEur = current.costEur == null || cost == null ? null : roundMoney(current.costEur + cost);
      current.quantity = roundMoney(current.quantity + holding.quantity, 8);
      if (current.image !== image) current.image = null;
      current.id = null;
      current.moves.push(...moves);
    } else {
      grouped.set(key, {
        label,
        eur: roundMoney(eur),
        group,
        costEur: cost,
        detail: floatDetail(holding.notes),
        image,
        id: holding._id == null ? null : String(holding._id),
        quantity: holding.quantity,
        followMarket: holding.followMarket !== false,
        quoteSource: holding.quoteSource || null,
        quoteId: holding.quoteId || null,
        moves,
      });
    }
  }
  for (const part of grouped.values()) {
    if (part.eur > 0) parts.push(part);
  }
  return parts;
}

function markedLiquidity(
  plan: {
    startDate: string;
    targetAmount: number;
    targetDate: string;
    monthlySavings: number;
    salary?: number | null;
    savingsDay?: number | null;
    savingsPaid?: string[];
    savingsSkipped?: string[];
    savingsAdjustments?: { date: string; amount: number; name?: string }[];
    recurring?: { _id?: unknown; name?: string; amount: number; dayOfMonth: number; paidDates?: string[]; direction?: 'in' | 'out' }[];
    intervals?: { _id?: unknown; name?: string; amount: number; everyWeeks: number; startDate: string; paidDates?: string[]; direction?: 'in' | 'out' }[];
    plannedExpenses?: { _id?: unknown; name?: string; amount: number; date: string; paid?: boolean; surprise?: boolean; automatic?: boolean; image?: string }[];
    settled?: { key: string; done: boolean; amount?: number }[];
    incomes?: { _id?: unknown; name?: string; amount: number; date: string; status?: 'expected' | 'confirmed'; paid?: boolean; surprise?: boolean; automatic?: boolean; image?: string }[];
  },
  opening: number,
  today: string,
  includedUntil = '',
): { balance: number; flows: CashFlow[]; fixed: FixedRule[] } {
  const months = planMonths({
    openingBalance: opening,
    startDate: plan.startDate,
    targetAmount: plan.targetAmount,
    targetDate: plan.targetDate,
    monthlySavings: plan.monthlySavings,
    salary: plan.salary || 0,
    savingsDay: plan.savingsDay,
    savingsPaid: plan.savingsPaid || [],
    savingsSkipped: plan.savingsSkipped || [],
    savingsAdjustments: plan.savingsAdjustments || [],
    settled: (plan.settled || []).map((item) => ({ key: item.key, done: item.done === true, amount: item.amount || 0 })),
    includedUntil,
    recurring: (plan.recurring || []).map((item) => ({
      id: refId(item),
      name: item.name,
      amount: item.amount,
      dayOfMonth: item.dayOfMonth,
      paidDates: item.paidDates || [],
      direction: item.direction === 'in' ? 'in' as const : 'out' as const,
    })),
    intervals: (plan.intervals || []).map((item) => ({
      id: refId(item),
      name: item.name,
      amount: item.amount,
      everyWeeks: item.everyWeeks,
      startDate: item.startDate,
      paidDates: item.paidDates || [],
      direction: item.direction === 'in' ? 'in' as const : 'out' as const,
    })),
    plannedExpenses: (plan.plannedExpenses || []).map((item) => ({
      id: refId(item),
      name: item.name,
      amount: item.amount,
      date: item.date,
      paid: item.paid === true,
      automatic: item.automatic === true || /^entrenador$/i.test(item.name || ''),
    })),
    incomes: (plan.incomes || []).map((item) => ({
      id: refId(item),
      name: item.name,
      amount: item.amount,
      date: item.date,
      status: item.status,
      paid: item.paid === true,
      automatic: item.automatic === true,
    })),
  }, today);
  const surprise = new Set<string>();
  const pictures = new Map<string, string>();
  for (const item of plan.plannedExpenses || []) {
    if (item._id == null) continue;
    const key = `expense:${String(item._id)}`;
    if (item.surprise) surprise.add(key);
    if (item.image) pictures.set(key, item.image);
  }
  for (const item of plan.incomes || []) {
    if (item._id == null) continue;
    const key = `income:${String(item._id)}`;
    if (item.surprise) surprise.add(key);
    if (item.image) pictures.set(key, item.image);
  }
  const flows: CashFlow[] = [];
  for (const month of months) {
    for (const line of month.lines) {
      if (line.amount == null || !line.day) continue;
      if (line.tone !== 'in' && line.tone !== 'out') continue;
      const waiting = line.automatic === true && line.absorbed === true && line.paid !== true;
      const markable = line.automatic !== true && line.paid !== true && Boolean(line.markKey) && line.day <= today;
      if (!line.paid && !waiting && !markable) continue;
      const key = line.markKey || `${line.day}:${line.label}`;
      flows.push({
        day: line.day,
        label: line.label,
        amount: line.amount,
        key,
        surprise: surprise.has(key),
        absorbed: line.absorbed === true,
        open: line.paid !== true,
        automatic: line.automatic === true,
        image: pictures.get(key) || '',
      });
    }
  }
  const fixed: FixedRule[] = [];
  if (plan.monthlySavings > 0) {
    const day = plan.savingsDay && plan.savingsDay >= 1 && plan.savingsDay <= 31 ? Math.round(plan.savingsDay) : 31;
    fixed.push({
      label: (plan.salary || 0) > 0 ? 'Nómina · parte ahorro' : 'Ahorro del mes',
      amount: plan.monthlySavings,
      rhythm: `Cada día ${day}`,
    });
  }
  for (const item of plan.recurring || []) {
    const incoming = item.direction === 'in';
    const id = refId(item);
    fixed.push({ label: item.name || (incoming ? 'Entrada fija' : 'Gasto fijo'), amount: incoming ? item.amount : -item.amount, rhythm: `Cada día ${item.dayOfMonth}`, key: id ? `recurring:${id}` : undefined });
  }
  for (const item of plan.intervals || []) {
    const incoming = item.direction === 'in';
    const weeks = Math.max(1, Math.round(item.everyWeeks || 1));
    const id = refId(item);
    fixed.push({ label: item.name || (incoming ? 'Entrada fija' : 'Gasto fijo'), amount: incoming ? item.amount : -item.amount, rhythm: `Cada ${weeks} ${weeks === 1 ? 'semana' : 'semanas'}`, key: id ? `interval:${id}` : undefined });
  }
  for (const item of plan.plannedExpenses || []) {
    if (!(item.automatic === true || /^entrenador$/i.test(item.name || ''))) continue;
    fixed.push({ label: item.name || 'Gasto', amount: -item.amount, rhythm: `El ${spanishDay(String(item.date))}` });
  }
  return { balance: balanceMarked(months, today, opening), flows, fixed };
}

interface FixedRule {
  label: string;
  amount: number;
  rhythm: string;
  key?: string;
}

function spanishDay(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  const names = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${day} ${names[(month || 1) - 1]} ${year}`;
}

interface CashFlow {
  day: string;
  label: string;
  amount: number;
  key: string;
  surprise: boolean;
  absorbed?: boolean;
  open?: boolean;
  automatic?: boolean;
  image?: string;
}

export async function getDashboard(userId: string, period: string) {
  await remindDuePayments(userId);
  const snap = await recordSnapshot(userId);
  const portfolio = snap.portfolio;
  const today = snap.day;
  const span: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };
  const key = period === 'all' || period in span ? period : '30d';
  const fromDay = key === 'all' ? '0000-01-01' : addDays(today, -(span[key] ?? 30));
  const snapshots = await Snapshot.find({ userId }).sort({ day: 1 }).lean();
  const variation = variationFromSnapshots(
    snapshots.map((item) => ({ day: item.day, netWorthEur: item.netWorthEur ?? null })),
    today,
    portfolio.netWorth.complete ? portfolio.netWorth.eur : null,
    fromDay,
  );
  const movements = await Movement.find({ userId, date: { $gte: fromDay === '0000-01-01' ? '0000-01-01' : fromDay, $lte: today } }).lean();
  const flow = analyzeMovements(movements.map(toMovementSnap), fromDay === '0000-01-01' ? null : fromDay, today);
  const accounts = await Account.find({ userId, archived: { $ne: true } }).sort({ name: 1 }).lean();
  const holdings = await Holding.find({ userId, accountId: { $in: accounts.map((account) => account._id) } }).lean();
  const pnl = pnlSlices(accounts.map(snapAccount), holdings.map(snapHolding)).map((slice) => {
    const account = accounts.find((item) => String(item._id) === slice.accountId);
    return {
      key: slice.key,
      label: slice.label,
      eur: slice.eur,
      accountName: account?.name || '',
      platform: account?.platform || '',
      place: '',
    };
  });
  const extraDocs = await Extra.find({ userId }).sort({ createdAt: 1 }).lean();
  const extraSummary = summarizeExtras(
    extraDocs.map((item) => ({
      id: String(item._id),
      place: item.place,
      name: item.name,
      valueEur: item.valueEur,
      costEur: item.costEur ?? null,
    })),
  );
  pnl.push(...extraSummary.pnl);

  const liquidityPlans = await Plan.find({ userId, kind: 'liquidez' }).lean();
  const wallets = await Wallet.find({ userId }).lean();
  const walletNet = new Map<string, number>();
  for (const book of wallets) {
    const net = (book.entries || []).reduce((sum, entry) => sum + (entry.direction === 'in' ? entry.amount : -entry.amount), 0);
    walletNet.set(String(book.accountId), roundMoney(net));
  }
  const markedCash = new Map<string, { balance: number; planId: string; flows: CashFlow[]; fixed: FixedRule[] }>();
  for (const plan of liquidityPlans) {
    const links = (plan.linkedAccountIds || []).map(String);
    if (links.length !== 1) continue;
    const linked = accounts.find((item) => String(item._id) === links[0]);
    if (!linked || linked.currency !== 'EUR') continue;
    const includedUntil = linked.balanceUpdatedAt ? todayKey('Europe/Madrid', new Date(linked.balanceUpdatedAt)) : '';
    const marked = markedLiquidity(plan, linked.balance, today, includedUntil);
    markedCash.set(links[0], { balance: marked.balance, planId: String(plan._id), flows: marked.flows, fixed: marked.fixed });
  }
  let cashDelta = 0;
  const accountViews = accounts.map((account) => {
    const id = String(account._id);
    const lines = portfolio.lines.filter((line) => line.accountId === id);
    const partial = lines.some((line) => line.eur == null);
    const rawValue = partial ? null : lines.reduce((sum, line) => sum + (line.eur || 0), 0);
    const marked = markedCash.get(id);
    const planShift = marked == null || account.currency !== 'EUR' ? 0 : marked.balance - account.balance;
    const noteShift = account.currency === 'EUR' && (marked != null || account.balance > 0) ? walletNet.get(id) || 0 : 0;
    const shift = roundMoney(planShift + noteShift);
    if (rawValue != null && shift !== 0) cashDelta += shift;
    const valueEur = rawValue == null ? null : roundMoney(rawValue + shift);
    const updated = account.balanceUpdatedAt || account.updatedAt;
    const shownBalance = roundMoney(account.balance + shift);
    const shown = shift === 0 ? account : { ...account, balance: shownBalance };
    return {
      id,
      name: account.name,
      platform: account.platform,
      kind: account.kind,
      tracking: account.tracking,
      currency: account.currency,
      balance: account.balance,
      valueEur,
      updatedAt: updated ? new Date(updated).toISOString() : null,
      stale: updated ? Date.now() - new Date(updated).getTime() > STALE_MS : false,
      parts: accountParts(shown, holdings, valueEur),
      planId: marked?.planId || null,
      flows: marked?.flows || [],
      fixed: marked?.fixed || [],
    };
  });

  return {
    today,
    period: key,
    currency: 'EUR',
    netWorth: { ...portfolio.netWorth, eur: roundMoney(portfolio.netWorth.eur + cashDelta) },
    available: portfolio.available,
    invested: portfolio.invested,
    crypto: portfolio.crypto,
    personalGoods: portfolio.personalGoods,
    unrealized: { eur: portfolio.unrealized.eur, complete: portfolio.unrealized.complete, excluded: portfolio.unrealized.excluded },
    contributions: { eur: flow.contributions.eur, complete: flow.contributions.complete },
    realized: { eur: flow.realized.eur, complete: flow.realized.complete },
    fees: { eur: flow.fees.eur, complete: flow.fees.complete },
    variation,
    series: snapshots
      .filter((item) => item.day >= fromDay && item.day <= today)
      .map((item) => ({ day: item.day, eur: item.valuedEur, complete: item.complete })),
    allocation: allocationSlices(portfolio),
    pnl,
    extras: extraDocs.map((item) => ({
      id: String(item._id),
      place: item.place,
      name: item.name,
      valueEur: item.valueEur,
      costEur: item.costEur ?? null,
      imageUrl: item.imageUrl || '',
      boughtOn: item.boughtOn || '',
      track: item.track === true,
      counts: item.counts !== false,
    })),
    accounts: accountViews,
    warnings: portfolio.warnings,
    hasAccounts: accounts.length > 0 || extraDocs.length > 0,
  };
}

function toMovementSnap(doc: {
  _id: unknown;
  type: MovementType;
  date: string;
  amount: number;
  currency: string;
  eurPerUnit?: number | null;
  accountId: unknown;
  counterAccountId?: unknown;
  effects?: { costOfSold?: number | null } | null;
  fee?: number | null;
}): MovementSnap {
  return {
    id: String(doc._id),
    type: doc.type,
    date: doc.date,
    amount: doc.amount,
    currency: doc.currency,
    eurPerUnit: doc.currency === 'EUR' ? null : (doc.eurPerUnit ?? null),
    accountId: String(doc.accountId),
    counterAccountId: doc.counterAccountId ? String(doc.counterAccountId) : null,
    costOfSold: doc.effects?.costOfSold ?? null,
    fee: doc.fee ?? null,
  };
}

function refId(item: { _id?: unknown; id?: string }): string | undefined {
  const value = item.id || item._id;
  return value ? String(value) : undefined;
}

function moneyEur(amount: number, currency: string, eurPerUnit?: number | null): number | null {
  if (currency === 'EUR') return amount;
  if (eurPerUnit && eurPerUnit > 0) return amount * eurPerUnit;
  return null;
}

function fieldClass(field: string): string | null {
  const key = field.trim().toLowerCase();
  if (!key) return null;
  if (key === 'etf') return 'etf';
  if (key === 'fondos' || key === 'fondo') return 'other';
  if (key === 'cripto' || key === 'crypto') return 'crypto';
  if (key === 'acciones' || key === 'accion') return 'stock';
  if (key === 'bienes') return 'personal_good';
  return key;
}

function sliceOf(
  accounts: { id: string; name: string; currency: string; balance: number; eurPerUnit?: number | null }[],
  holdings: { accountId: string; assetClass: string; quantity: number; unitMarketValue?: number | null; currency: string; eurPerUnit?: number | null }[],
  kind: 'patrimonio' | 'liquidez' | 'inversion',
  field: string,
): { amount: number; label: string; incomplete: boolean } | null {
  const names = accounts.map((account) => account.name).join(' y ');
  let incomplete = false;
  const liquid = accounts.reduce((sum, account) => {
    const eur = moneyEur(account.balance, account.currency, account.eurPerUnit);
    if (eur == null) {
      incomplete = true;
      return sum;
    }
    return sum + eur;
  }, 0);
  const wanted = kind === 'inversion' ? fieldClass(field) : null;
  const invested = holdings.reduce((sum, holding) => {
    if (!accounts.some((account) => account.id === holding.accountId)) return sum;
    if (wanted && holding.assetClass !== wanted) return sum;
    if (!(holding.quantity > 0)) return sum;
    if (holding.unitMarketValue == null) {
      incomplete = true;
      return sum;
    }
    const eur = moneyEur(holding.unitMarketValue * holding.quantity, holding.currency, holding.eurPerUnit);
    if (eur == null) {
      incomplete = true;
      return sum;
    }
    return sum + eur;
  }, 0);
  if (kind === 'liquidez') {
    return { amount: roundMoney(liquid), label: `la liquidez de ${names}`, incomplete };
  }
  if (kind === 'inversion') {
    const what = field.trim() || 'la inversión';
    return { amount: roundMoney(invested), label: `${what} de ${names}`, incomplete };
  }
  return { amount: roundMoney(liquid + invested), label: names, incomplete };
}

export async function forecastForPlan(
  plan: {
    openingBalance: number;
    kind?: string;
    field?: string;
    startDate: string;
    targetAmount: number;
    targetDate: string;
    monthlySavings: number;
    salary?: number;
    savingsPaid?: string[];
    savingsSkipped?: string[];
    savingsAdjustments?: { date: string; amount: number; name?: string }[];
    settled?: { key: string; done: boolean; amount?: number }[];
    linkedAccountIds?: unknown[];
    manualRealBalance?: number | null;
    savingsDay?: number | null;
    recurring?: { _id?: unknown; id?: string; name?: string; amount: number; dayOfMonth: number; paidDates?: string[]; direction?: 'in' | 'out' }[];
    intervals?: { _id?: unknown; id?: string; name?: string; amount: number; everyWeeks: number; startDate: string; paidDates?: string[]; direction?: 'in' | 'out' }[];
    plannedExpenses?: { _id?: unknown; id?: string; name?: string; amount: number; date: string; paid?: boolean; automatic?: boolean }[];
    incomes?: { _id?: unknown; id?: string; name?: string; amount: number; date: string; status?: 'expected' | 'confirmed'; paid?: boolean; automatic?: boolean }[];
    scenarios?: { _id?: unknown; name: string; monthlySavings: number }[];
  },
  userId: string,
) {
  const user = await User.findById(userId).select('timezone');
  const today = todayKey(user?.timezone || 'Europe/Madrid');
  let real: number | null = plan.manualRealBalance ?? null;
  const notes: string[] = [];
  const links = (plan.linkedAccountIds || []).map(String);
  const books = links.length ? await loadBooks(userId) : null;
  const linked = books ? books.accounts.filter((account) => links.includes(account.id)) : [];
  if (links.length) {
    if (linked.length !== links.length) notes.push('Alguna cuenta vinculada ya no está disponible.');
    const missingFx = linked.filter((account) => account.currency !== 'EUR' && !(account.eurPerUnit && account.eurPerUnit > 0));
    if (missingFx.length) {
      real = null;
      notes.push('El saldo real no está cerrado: hay cuentas vinculadas sin tipo de cambio a euros.');
    } else {
      real = linked.reduce((sum, account) => {
        const rate = account.currency === 'EUR' ? 1 : account.eurPerUnit || 0;
        return sum + account.balance * rate;
      }, 0);
      notes.push('El saldo real es el efectivo de las cuentas vinculadas, sin valorar los activos por el precio de mercado.');
    }
  }
  const kind = plan.kind === 'liquidez' || plan.kind === 'inversion' ? plan.kind : 'patrimonio';
  const slice = books && linked.length ? sliceOf(linked, books.holdings, kind, plan.field || '') : null;
  const opening = slice && !slice.incomplete ? slice.amount : plan.openingBalance;
  if (slice?.incomplete) notes.push('El plan no puede usar ese sitio hasta que el importe esté en euros.');
  const liveCash = kind === 'liquidez' && Boolean(slice && !slice.incomplete && linked.length === 1);
  const includedUntil = liveCash && linked[0]?.updatedAt ? todayKey(user?.timezone || 'Europe/Madrid', new Date(linked[0].updatedAt)) : '';
  const forecast = forecastPlan(
    {
      openingBalance: opening,
      startDate: plan.startDate,
      targetAmount: plan.targetAmount,
      targetDate: plan.targetDate,
      monthlySavings: plan.monthlySavings,
      salary: plan.salary || 0,
      savingsDay: plan.savingsDay,
      savingsPaid: plan.savingsPaid || [],
      savingsSkipped: plan.savingsSkipped || [],
      savingsAdjustments: plan.savingsAdjustments || [],
      settled: (plan.settled || []).map((item) => ({ key: item.key, done: item.done === true, amount: item.amount || 0 })),
      includedUntil,
      recurring: (plan.recurring || []).map((item) => ({
        id: refId(item),
        name: item.name,
        amount: item.amount,
        dayOfMonth: item.dayOfMonth,
        paidDates: item.paidDates || [],
        direction: item.direction === 'in' ? 'in' as const : 'out' as const,
      })),
      intervals: (plan.intervals || []).map((item) => ({
        id: refId(item),
        name: item.name,
        amount: item.amount,
        everyWeeks: item.everyWeeks,
        startDate: item.startDate,
        paidDates: item.paidDates || [],
        direction: item.direction === 'in' ? 'in' as const : 'out' as const,
      })),
      plannedExpenses: (plan.plannedExpenses || []).map((item) => {
        const automatic = item.automatic === true || /^entrenador$/i.test(item.name || '');
        return {
          id: refId(item),
          name: item.name,
          amount: item.amount,
          date: item.date,
          paid: item.paid === true,
          automatic,
        };
      }),
      incomes: (plan.incomes || []).map((item) => ({
        id: refId(item),
        name: item.name,
        amount: item.amount,
        date: item.date,
        status: item.status,
        paid: item.paid === true,
        automatic: item.automatic === true,
      })),
      scenarios: (plan.scenarios || []).map((item) => ({
        id: String(item._id),
        name: item.name,
        monthlySavings: item.monthlySavings,
      })),
    },
    real,
    today,
  );
  return {
    ...forecast,
    realBalance: real,
    notes: [...forecast.notes, ...notes],
    today,
    anchor: slice && !slice.incomplete ? { amount: slice.amount, label: slice.label } : null,
  };
}