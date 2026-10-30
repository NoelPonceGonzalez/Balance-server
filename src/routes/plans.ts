import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { Plan } from '../models/Plan.js';
import { netsAfterConfirmed, splitTrip, transfersOf } from '../domain/split.js';
import { Account } from '../models/Account.js';
import { User } from '../models/User.js';
import { Notification } from '../models/Notification.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { asyncRoute, HttpError } from '../http.js';
import { asDay, asId, asMoney, asOptionalMoney, asPicture, asReceipt, asText } from '../validate.js';
import { roundMoney, todayKey } from '../domain/finance.js';
import { createMovement, deleteMovement, forecastForPlan, forecastPlanList } from '../services/ledger.js';
import { listDueFixed, remindDuePayments } from '../services/plan-reminders.js';

const router = Router();
router.use(authenticateToken);

function owner(req: AuthRequest) {
  return req.userId as string;
}

const PERSON_COLORS = ['#ea580c', '#2563eb', '#16a34a', '#db2777', '#7c3aed', '#0891b2', '#ca8a04', '#e11d48', '#4f46e5', '#0f766e'];

function joinCodeOk(code: string): boolean {
  return /^[A-Za-z0-9_-]{8,24}$/.test(code);
}

function splitOf(plan: {
  members?: { userId: unknown; name: string; color: string; contributed?: number }[];
  tripExpenses?: { paidBy: unknown; amount: number; splitAmong?: unknown[] }[];
  settlements?: { status?: string; fromId: unknown; toId: unknown; amount: number }[];
}) {
  const live = splitTrip(
    (plan.members || []).map((member) => ({
      id: String(member.userId),
      name: member.name,
      color: member.color,
      contributed: member.contributed || 0,
    })),
    (plan.tripExpenses || []).map((expense) => ({
      paidBy: String(expense.paidBy),
      amount: expense.amount,
      splitAmong: (expense.splitAmong || []).map((id) => String(id)),
    })),
  );
  const confirmed = (plan.settlements || []).filter((row) => row.status === 'confirmed');
  if (confirmed.length === 0) return live;
  const people = netsAfterConfirmed(live.people, confirmed.map((row) => ({
    fromId: String(row.fromId),
    toId: String(row.toId),
    amount: row.amount,
  })));
  return { ...live, people, transfers: transfersOf(people) };
}

function tripPhase(plan: { tripStatus?: string }): 'active' | 'settling' | 'done' {
  if (plan.tripStatus === 'settling' || plan.tripStatus === 'done') return plan.tripStatus;
  return 'active';
}

function assertOpen(plan: { tripStatus?: string }) {
  if (tripPhase(plan) !== 'active') throw new HttpError(400, 'El reparto está cerrado. El creador puede reabrirlo para corregir un gasto.');
}

const EXPENSE_KINDS = ['Comida', 'Transporte', 'Casa', 'Ocio', 'Otro'];

function expenseKind(value: unknown): string {
  return typeof value === 'string' && EXPENSE_KINDS.includes(value) ? value : '';
}

function expenseAmong(plan: { members: { userId: unknown }[] }, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const ids = value.map((id) => memberId(plan, id, 'Quién entra en el gasto'));
  const unique = [...new Set(ids)];
  if (unique.length >= plan.members.length) return [];
  return unique;
}

async function loadTrip(userId: string, id: string) {
  const plan = await Plan.findOne({
    _id: asId(id, 'El plan'),
    kind: 'gastos',
    $or: [{ userId }, { 'members.userId': userId }],
  });
  if (!plan) throw new HttpError(404, 'Ese reparto no está.');
  if (!plan.settlements) plan.set('settlements', []);
  if (!plan.tripActivity) plan.set('tripActivity', []);
  return plan;
}

function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value) ? value : undefined;
}

function readDates(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'Las fechas marcadas no son válidas.');
  return value.map((item) => asDay(item, 'La fecha marcada'));
}

function readEvents(value: unknown, withStatus: boolean) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'La lista de importes no es válida.');
  return value.map((item) => {
    const row = item as Record<string, unknown>;
    const status = row.status === 'expected' ? 'expected' : 'confirmed';
    const id = optionalId(row.id);
    return {
      ...(id ? { _id: id } : {}),
      name: asText(row.name, 'El concepto', 80),
      amount: asMoney(row.amount, 'El importe'),
      date: asDay(row.date, 'La fecha'),
      paid: row.paid === true,
      surprise: row.surprise === true,
      automatic: row.automatic === true,
      image: asPicture(row.image),
      ...(withStatus ? { status } : {}),
    };
  });
}

function readPlan(body: Record<string, unknown>) {
  const recurring = Array.isArray(body.recurring) ? body.recurring : [];
  const intervals = Array.isArray(body.intervals) ? body.intervals : [];
  const scenarios = Array.isArray(body.scenarios) ? body.scenarios : [];
  return {
    name: asText(body.name, 'El nombre', 80),
    kind: body.kind === 'liquidez' || body.kind === 'inversion' ? body.kind : 'patrimonio',
    field: asText(body.field, 'El campo', 40, false),
    salary: asMoney(body.salary ?? 0, 'La nómina', true),
    salaryAccountId: body.salaryAccountId ? asId(body.salaryAccountId, 'La cuenta de la nómina') : null,
    savingsDay: body.savingsDay == null || body.savingsDay === '' ? null : Math.min(31, Math.max(1, Math.round(asMoney(body.savingsDay, 'El día de ahorro')))),
    openingBalance: asMoney(body.openingBalance ?? 0, 'El saldo inicial', true),
    startDate: asDay(body.startDate, 'La fecha de inicio'),
    targetAmount: asMoney(body.targetAmount, 'El objetivo'),
    targetDate: asDay(body.targetDate, 'La fecha objetivo'),
    monthlySavings: asMoney(body.monthlySavings ?? 0, 'El ahorro mensual', true),
    linkedAccountIds: Array.isArray(body.linkedAccountIds) ? body.linkedAccountIds.map((id) => asId(id, 'La cuenta')) : [],
    manualRealBalance: asOptionalMoney(body.manualRealBalance, 'El saldo real'),
    recurring: recurring.map((item) => {
      const row = item as Record<string, unknown>;
      const day = asMoney(row.dayOfMonth, 'El día del mes');
      if (day > 31) throw new HttpError(400, 'El día del mes no puede pasar de 31.');
      const id = optionalId(row.id);
      return {
        ...(id ? { _id: id } : {}),
        name: asText(row.name, 'El gasto', 80),
        amount: asMoney(row.amount, 'El importe'),
        dayOfMonth: Math.round(day),
        direction: row.direction === 'in' ? 'in' : 'out',
        paidDates: readDates(row.paidDates),
      };
    }),
    intervals: intervals.map((item) => {
      const row = item as Record<string, unknown>;
      const weeks = Math.round(asMoney(row.everyWeeks, 'Las semanas'));
      if (weeks > 52) throw new HttpError(400, 'El intervalo no puede pasar de 52 semanas.');
      const id = optionalId(row.id);
      return {
        ...(id ? { _id: id } : {}),
        name: asText(row.name, 'El gasto', 80),
        amount: asMoney(row.amount, 'El importe'),
        everyWeeks: weeks,
        startDate: asDay(row.startDate, 'La fecha de inicio del gasto'),
        direction: row.direction === 'in' ? 'in' : 'out',
        paidDates: readDates(row.paidDates),
      };
    }),
    plannedExpenses: readEvents(body.plannedExpenses, false),
    incomes: readEvents(body.incomes, true),
    scenarios: scenarios.map((item) => {
      const row = item as Record<string, unknown>;
      return { name: asText(row.name, 'El escenario', 80), monthlySavings: asMoney(row.monthlySavings ?? 0, 'El ahorro del escenario', true) };
    }),
  };
}

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const plansPromise = Plan.find({ $or: [{ userId }, { 'members.userId': userId }] }).sort({ createdAt: -1 });
    const remindPromise = remindDuePayments(userId);
    const plans = await plansPromise;
    const withForecast = await forecastPlanList(userId, plans);
    await remindPromise;
    res.json({
      plans: withForecast.map((row) => {
        const plan = hideReceipts(row.plan);
        return {
          plan,
          forecast: row.forecast,
          ...(row.plan.kind === 'gastos' ? { split: splitOf(row.plan) } : {}),
        };
      }),
    });
  }),
);

router.get(
  '/due',
  asyncRoute(async (req, res) => {
    res.json({ prompts: await listDueFixed(owner(req as AuthRequest)) });
  }),
);

router.post(
  '/:id/settle',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const body = (req.body || {}) as Record<string, unknown>;
    const key = asText(body.key, 'El fijo', 120);
    const done = body.done === true;
    const plan = await Plan.findOne({ _id: asId(req.params.id, 'El plan'), userId });
    if (!plan) throw new HttpError(404, 'Ese plan no existe.');
    if (!plan.settled) plan.set('settled', []);
    if (plan.settled.some((item) => item.key === key)) throw new HttpError(400, 'Eso ya está confirmado.');
    const [kind, id, occurrence] = key.split(':');
    let direction: 'in' | 'out' = 'out';
    let day = '';
    let planned = 0;
    if (kind === 'expense') {
      const item = plan.plannedExpenses.find((row) => String(row._id) === id);
      if (!item) throw new HttpError(404, 'Ese fijo no está en el plan.');
      day = String(item.date).slice(0, 10);
      planned = item.amount;
      direction = 'out';
      const amount = done ? asMoney(body.amount, 'El importe') : item.amount;
      if (done) item.amount = amount;
      item.paid = done;
      plan.settled.push({ key, done, amount: done ? amount : 0 });
    } else if (kind === 'savings') {
      day = asDay(id, 'La fecha');
      planned = plan.monthlySavings;
      direction = 'in';
      const amount = done ? asMoney(body.amount, 'El importe') : 0;
      if (done) {
        const kept = plan.savingsAdjustments.filter((item) => item.date !== day);
        plan.savingsAdjustments.splice(0, plan.savingsAdjustments.length);
        for (const row of kept) plan.savingsAdjustments.push({ date: row.date, amount: row.amount, name: row.name || '' });
        plan.savingsAdjustments.push({ date: day, amount, name: '' });
        if (!(plan.savingsPaid || []).includes(day)) plan.savingsPaid.push(day);
        plan.savingsSkipped = (plan.savingsSkipped || []).filter((item) => item !== day);
      } else if (!(plan.savingsSkipped || []).includes(day)) {
        plan.savingsSkipped.push(day);
        plan.savingsPaid = (plan.savingsPaid || []).filter((item) => item !== day);
      }
      plan.settled.push({ key, done, amount });
    } else if (kind === 'recurring' || kind === 'interval') {
      const list = kind === 'recurring' ? plan.recurring : plan.intervals;
      const item = list.find((row) => String(row._id) === id);
      if (!item) throw new HttpError(404, 'Ese fijo no está en el plan.');
      day = asDay(occurrence, 'La fecha');
      planned = item.amount;
      direction = item.direction === 'in' ? 'in' : 'out';
      const amount = done ? asMoney(body.amount, 'El importe') : 0;
      plan.settled.push({ key, done, amount });
    } else {
      throw new HttpError(400, 'No se reconoce ese fijo.');
    }
    const user = await User.findById(userId).select('timezone');
    const zone = user?.timezone || 'Europe/Madrid';
    const links = (plan.linkedAccountIds || []).map(String);
    if (plan.kind === 'liquidez' && links.length === 1) {
      const account = await Account.findOne({ _id: links[0], userId });
      const updated = account?.balanceUpdatedAt ? todayKey(zone, account.balanceUpdatedAt) : '';
      if (account && account.currency === 'EUR' && updated && day <= updated) {
        const actual = done ? asMoney(body.amount, 'El importe') : 0;
        const diff = actual - planned;
        const delta = done ? (direction === 'out' ? -diff : diff) : direction === 'out' ? planned : -planned;
        if (delta !== 0) {
          account.balance = roundMoney(account.balance + delta);
          account.balanceUpdatedAt = new Date();
          await account.save();
        }
      }
    }
    await plan.save();
    await Notification.deleteMany({ userId, quoteKey: `plan-due:${plan._id}:${key}` });
    const forecast = await forecastForPlan(plan, userId);
    res.json({ plan, forecast });
  }),
);

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const body = (req.body || {}) as Record<string, unknown>;
    if (body.kind === 'gastos') {
      const user = await User.findById(userId).select('name timezone');
      const day = todayKey(user?.timezone || 'Europe/Madrid');
      const plan = await Plan.create({
        userId,
        name: asText(body.name, 'El nombre', 80),
        kind: 'gastos',
        joinCode: randomBytes(9).toString('base64url'),
        members: [{
          userId,
          name: (user?.name || 'Tú').slice(0, 80),
          color: PERSON_COLORS[0],
          contributed: asMoney(body.contributed ?? 0, 'Lo aportado', true),
        }],
        tripExpenses: [],
        openingBalance: 0,
        startDate: day,
        targetAmount: 0,
        targetDate: day,
        monthlySavings: 0,
        linkedAccountIds: [],
      });
      res.status(201).json({ plan, forecast: await forecastForPlan(plan, userId), split: splitOf(plan) });
      return;
    }
    const plan = await Plan.create({ userId, ...readPlan(body) });
    await remindDuePayments(userId);
    const forecast = await forecastForPlan(plan, userId);
    res.status(201).json({ plan, forecast });
  }),
);

router.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const id = asId(req.params.id, 'El plan');
    const existing = await Plan.findOne({ _id: id, userId });
    if (!existing) throw new HttpError(404, 'Ese plan no existe.');
    if (existing.kind === 'gastos') throw new HttpError(400, 'Este reparto se cambia desde sus gastos.');
    const plan = await Plan.findOneAndUpdate({ _id: id, userId }, readPlan(req.body || {}), {
      new: true,
    });
    if (!plan) throw new HttpError(404, 'Ese plan no existe.');
    await remindDuePayments(userId);
    const forecast = await forecastForPlan(plan, userId);
    res.json({ plan, forecast });
  }),
);

router.post(
  '/:id/mark',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const body = (req.body || {}) as Record<string, unknown>;
    const key = asText(body.key, 'El gasto', 120);
    const paid = body.paid === true;
    const plan = await Plan.findOne({ _id: asId(req.params.id, 'El plan'), userId });
    if (!plan) throw new HttpError(404, 'Ese plan no existe.');
    const [kind, id, date] = key.split(':');
    if (kind === 'expense' || kind === 'income') {
      const list = kind === 'expense' ? plan.plannedExpenses : plan.incomes;
      const item = list.find((row) => String(row._id) === id);
      if (!item) throw new HttpError(404, 'Ese apunte no está en el plan.');
      item.paid = paid;
    } else if (kind === 'savings') {
      const day = asDay(id, 'La fecha');
      const dates = new Set(plan.savingsPaid || []);
      if (paid) dates.add(day);
      else dates.delete(day);
      plan.savingsPaid = [...dates];
    } else if (kind === 'recurring' || kind === 'interval') {
      const list = kind === 'recurring' ? plan.recurring : plan.intervals;
      const item = list.find((row) => String(row._id) === id);
      if (!item) throw new HttpError(404, 'Ese apunte no está en el plan.');
      const day = asDay(date, 'La fecha');
      const dates = new Set(item.paidDates || []);
      if (paid) dates.add(day);
      else dates.delete(day);
      item.paidDates = [...dates];
    } else {
      throw new HttpError(400, 'No se reconoce ese apunte.');
    }
    await plan.save();
    if (paid) await Notification.deleteMany({ userId, quoteKey: `plan-due:${plan._id}:${key}` });
    else await remindDuePayments(userId);
    const forecast = await forecastForPlan(plan, userId);
    res.json({ plan, forecast });
  }),
);

router.post(
  '/:id/entry',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const body = (req.body || {}) as Record<string, unknown>;
    const key = asText(body.key, 'El apunte', 120);
    const remove = body.remove === true;
    const plan = await Plan.findOne({ _id: asId(req.params.id, 'El plan'), userId });
    if (!plan) throw new HttpError(404, 'Ese plan no existe.');
    const [kind, id, occurrence] = key.split(':');
    if (kind === 'expense' || kind === 'income') {
      const list = kind === 'expense' ? plan.plannedExpenses : plan.incomes;
      const item = list.find((row) => String(row._id) === id);
      if (!item) throw new HttpError(404, 'Ese apunte no está en el plan.');
      if (remove) {
        list.pull(item._id);
      } else {
        item.name = asText(body.name, 'El nombre', 80);
        item.amount = asMoney(body.amount, 'El importe');
        item.date = asDay(body.date, 'La fecha');
        if (typeof body.image === 'string') item.image = asPicture(body.image);
      }
    } else if (kind === 'recurring') {
      const item = plan.recurring.find((row) => String(row._id) === id);
      if (!item) throw new HttpError(404, 'Ese apunte no está en el plan.');
      if (remove) {
        plan.recurring.pull(item._id);
      } else {
        item.name = asText(body.name, 'El nombre', 80);
        item.amount = asMoney(body.amount, 'El importe');
        const day = Math.round(asMoney(body.dayOfMonth ?? occurrence, 'El día'));
        if (day > 31) throw new HttpError(400, 'El día del mes no puede pasar de 31.');
        item.dayOfMonth = day;
      }
    } else if (kind === 'interval') {
      const item = plan.intervals.find((row) => String(row._id) === id);
      if (!item) throw new HttpError(404, 'Ese apunte no está en el plan.');
      if (remove) {
        plan.intervals.pull(item._id);
      } else {
        item.name = asText(body.name, 'El nombre', 80);
        item.amount = asMoney(body.amount, 'El importe');
        const weeks = Math.round(asMoney(body.everyWeeks, 'Las semanas'));
        if (weeks > 52) throw new HttpError(400, 'El intervalo no puede pasar de 52 semanas.');
        item.everyWeeks = weeks;
      }
    } else if (kind === 'savings') {
      const day = asDay(id, 'La fecha');
      const kept = plan.savingsAdjustments.filter((item) => item.date !== day);
      plan.savingsAdjustments.splice(0, plan.savingsAdjustments.length);
      for (const row of kept) plan.savingsAdjustments.push({ date: row.date, amount: row.amount, name: row.name || '' });
      if (remove) {
        if (!plan.savingsSkipped.includes(day)) plan.savingsSkipped.push(day);
        plan.savingsPaid = (plan.savingsPaid || []).filter((item) => item !== day);
      } else {
        const amount = asMoney(body.amount, 'El importe');
        const name = asText(body.name ?? '', 'El nombre', 80, false);
        plan.savingsAdjustments.push({ date: day, amount, name });
        plan.savingsSkipped = (plan.savingsSkipped || []).filter((item) => item !== day);
      }
    } else {
      throw new HttpError(400, 'No se reconoce ese apunte.');
    }
    await plan.save();
    const forecast = await forecastForPlan(plan, userId);
    res.json({ plan, forecast });
  }),
);

router.post(
  '/:id/fixed',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const body = (req.body || {}) as Record<string, unknown>;
    const plan = await Plan.findOne({ _id: asId(req.params.id, 'El plan'), userId });
    if (!plan) throw new HttpError(404, 'Ese plan no existe.');
    const name = asText(body.name, 'El nombre', 80);
    const amount = asMoney(body.amount, 'El importe');
    const direction = body.direction === 'in' ? 'in' : 'out';
    if (body.rhythm === 'weeks') {
      const weeks = Math.round(asMoney(body.everyWeeks, 'Las semanas'));
      if (weeks < 1 || weeks > 52) throw new HttpError(400, 'Las semanas tienen que estar entre 1 y 52.');
      plan.intervals.push({ name, amount, everyWeeks: weeks, startDate: asDay(body.startDate, 'La fecha'), direction });
    } else {
      const day = Math.round(asMoney(body.dayOfMonth, 'El día'));
      if (day < 1 || day > 31) throw new HttpError(400, 'El día del mes tiene que estar entre 1 y 31.');
      plan.recurring.push({ name, amount, dayOfMonth: day, direction });
    }
    await plan.save();
    await remindDuePayments(userId);
    const forecast = await forecastForPlan(plan, userId);
    res.status(201).json({ plan, forecast });
  }),
);

router.post(
  '/:id/extra',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const body = (req.body || {}) as Record<string, unknown>;
    const plan = await Plan.findOne({ _id: asId(req.params.id, 'El plan'), userId });
    if (!plan) throw new HttpError(404, 'Ese plan no existe.');
    const entry = {
      name: asText(body.name, 'El nombre', 80),
      amount: asMoney(body.amount, 'El importe'),
      date: asDay(body.date, 'La fecha'),
      paid: body.paid === true,
      image: asPicture(body.image),
    };
    if (body.direction === 'in') plan.incomes.push({ ...entry, status: 'confirmed', surprise: true });
    else plan.plannedExpenses.push({ ...entry, surprise: true });
    await plan.save();
    await remindDuePayments(userId);
    const forecast = await forecastForPlan(plan, userId);
    res.status(201).json({ plan, forecast });
  }),
);

router.post(
  '/:id/pace-reset',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const plan = await Plan.findOne({ _id: asId(req.params.id, 'El plan'), userId });
    if (!plan) throw new HttpError(404, 'Ese plan no existe.');
    const ids = [
      ...plan.plannedExpenses.filter((item) => item.surprise).map((item) => String(item._id)),
      ...plan.incomes.filter((item) => item.surprise).map((item) => String(item._id)),
    ];
    plan.surpriseCleared = [...new Set([...(plan.surpriseCleared || []), ...ids])];
    await plan.save();
    const forecast = await forecastForPlan(plan, userId);
    res.json({ plan, forecast });
  }),
);

router.get(
  '/join/:code',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const code = String(req.params.code || '');
    if (!joinCodeOk(code)) throw new HttpError(400, 'Ese enlace no es válido.');
    const plan = await Plan.findOne({ joinCode: code, kind: 'gastos' });
    if (!plan) throw new HttpError(404, 'Ese reparto no está.');
    const people = plan.members.length;
    res.json({
      planId: String(plan._id),
      name: plan.name,
      people,
      joined: plan.members.some((item) => String(item.userId) === userId),
      full: people >= 10,
    });
  }),
);

router.post(
  '/join',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const body = (req.body || {}) as Record<string, unknown>;
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!joinCodeOk(code)) throw new HttpError(400, 'Ese enlace no es válido.');
    const plan = await Plan.findOne({ joinCode: code, kind: 'gastos' });
    if (!plan) throw new HttpError(404, 'Ese reparto no está.');
    if (plan.members.some((item) => String(item.userId) === userId)) {
      res.json({ planId: String(plan._id), joined: true });
      return;
    }
    if (plan.members.length >= 10) throw new HttpError(400, 'Ya sois 10, no cabe nadie más.');
    const user = await User.findById(userId).select('name');
    const used = new Set(plan.members.map((item) => item.color));
    const color = PERSON_COLORS.find((item) => !used.has(item)) || PERSON_COLORS[plan.members.length % PERSON_COLORS.length];
    plan.members.push({
      userId,
      name: (user?.name || 'Tú').slice(0, 80),
      color,
      contributed: asMoney(body.contributed ?? 0, 'Lo aportado', true),
    });
    await plan.save();
    res.status(201).json({ planId: String(plan._id), joined: true });
  }),
);

function memberId(plan: { members: { userId: unknown }[] }, value: unknown, field: string): string {
  const id = asId(value, field);
  if (!id || !plan.members.some((item) => String(item.userId) === id)) throw new HttpError(400, 'Esa persona no está en el reparto.');
  return id;
}

router.patch(
  '/:id/pot',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const plan = await loadTrip(userId, String(req.params.id));
    const body = (req.body || {}) as Record<string, unknown>;
    const target = body.userId ? memberId(plan, body.userId, 'La persona') : userId;
    if (target !== userId && String(plan.userId) !== userId) throw new HttpError(403, 'Solo puedes cambiar lo que has puesto tú.');
    const member = plan.members.find((item) => String(item.userId) === target);
    if (!member) throw new HttpError(404, 'Esa persona no está en el reparto.');
    assertOpen(plan);
    member.contributed = asMoney(body.contributed ?? 0, 'Lo aportado', true);
    await plan.save();
    res.json({ ok: true });
  }),
);

router.post(
  '/tique',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const body = (req.body || {}) as Record<string, unknown>;
    const name = asText(body.name, 'El gasto', 80);
    const amount = asMoney(body.amount, 'El importe');
    asReceipt(body.receipt, true);
    const accountId = asId(body.accountId, 'El banco') as string;
    await chargeFull(userId, accountId, amount, name);
    const plans = await Plan.find({ userId, linkedAccountIds: accountId, kind: { $ne: 'gastos' } }).select('name');
    res.status(201).json({ ok: true, plans: plans.map((plan) => plan.name) });
  }),
);

router.post(
  '/:id/gasto',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const plan = await loadTrip(userId, String(req.params.id));
    assertOpen(plan);
    const body = (req.body || {}) as Record<string, unknown>;
    const user = await User.findById(userId).select('timezone');
    const paidBy = memberId(plan, body.paidBy, 'Quién lo ha pagado');
    const payer = plan.members.find((item) => String(item.userId) === paidBy);
    const name = asText(body.name, 'El gasto', 80);
    const amount = asMoney(body.amount, 'El importe');
    const receipt = asReceipt(body.receipt);
    let charge: 'none' | 'pending' | 'done' = 'none';
    let chargeAccountId: string | null = null;
    let chargeMovementId = '';
    if (receipt) {
      if (paidBy === userId) {
        chargeAccountId = asId(body.accountId, 'El banco') as string;
        chargeMovementId = await chargeFull(userId, chargeAccountId, amount, name);
        charge = 'done';
      } else {
        charge = 'pending';
      }
    }
    plan.tripExpenses.push({
      name,
      amount,
      paidBy,
      paidByName: payer?.name || '',
      category: expenseKind(body.category),
      splitAmong: expenseAmong(plan, body.splitAmong),
      date: todayKey(user?.timezone || 'Europe/Madrid'),
      receipt,
      charge,
      chargeAccountId,
      chargeMovementId,
    });
    await plan.save();
    if (charge === 'pending') {
      await tell(String(plan._id), [paidBy], 'Tique por aceptar', `${name}: ${moneyLabel(amount)}. Cuando entres, confirmas que es tuyo y se resta el 100% de tu banco.`);
    }
    res.status(201).json({ ok: true });
  }),
);

router.patch(
  '/:id/gasto/:expenseId',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const plan = await loadTrip(userId, String(req.params.id));
    assertOpen(plan);
    const body = (req.body || {}) as Record<string, unknown>;
    const row = plan.tripExpenses.find((item) => String(item._id) === String(req.params.expenseId || ''));
    if (!row) throw new HttpError(404, 'Ese gasto no está.');
    row.name = asText(body.name, 'El gasto', 80);
    row.amount = asMoney(body.amount, 'El importe');
    row.paidBy = memberId(plan, body.paidBy, 'Quién lo ha pagado');
    row.paidByName = plan.members.find((item) => String(item.userId) === String(row.paidBy))?.name || row.paidByName || '';
    row.set('category', expenseKind(body.category));
    row.set('splitAmong', expenseAmong(plan, body.splitAmong));
    await plan.save();
    res.json({ ok: true });
  }),
);

router.delete(
  '/:id/gasto/:expenseId',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const plan = await loadTrip(userId, String(req.params.id));
    assertOpen(plan);
    const row = plan.tripExpenses.find((item) => String(item._id) === String(req.params.expenseId || ''));
    if (!row) throw new HttpError(404, 'Ese gasto no está.');
    const movementId = String(row.get('chargeMovementId') || '');
    if (row.get('charge') === 'done' && movementId) {
      if (String(row.paidBy) !== userId) throw new HttpError(400, 'Quien pagó el tique es quien puede quitarlo, para devolver el dinero a su banco.');
      try {
        await deleteMovement(userId, movementId);
      } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 404) throw err;
      }
    }
    plan.tripExpenses.pull(row._id);
    await plan.save();
    res.json({ ok: true });
  }),
);

router.post(
  '/:id/gasto/:expenseId/aceptar',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const plan = await loadTrip(userId, String(req.params.id));
    assertOpen(plan);
    const row = plan.tripExpenses.find((item) => String(item._id) === String(req.params.expenseId || ''));
    if (!row) throw new HttpError(404, 'Ese gasto no está.');
    if (String(row.paidBy) !== userId) throw new HttpError(403, 'Solo quien pagó el tique puede aceptarlo.');
    if (row.get('charge') !== 'pending') throw new HttpError(400, 'Este tique ya está aplicado.');
    const accountId = asId((req.body || {}).accountId, 'El banco') as string;
    const movementId = await chargeFull(userId, accountId, row.amount, row.name);
    row.set('charge', 'done');
    row.set('chargeAccountId', accountId);
    row.set('chargeMovementId', movementId);
    await plan.save();
    res.json({ ok: true });
  }),
);

async function leaveReparto(plan: Awaited<ReturnType<typeof loadTrip>>, userId: string) {
  if (tripPhase(plan) !== 'active') throw new HttpError(400, 'Este reparto está en liquidación. El creador puede reabrirlo si hay que corregir algo.');
  const member = plan.members.find((item) => String(item.userId) === userId);
  const name = member?.name || 'Alguien';
  for (const expense of plan.tripExpenses) {
    if (String(expense.paidBy) === userId) expense.paidByName = name;
  }
  const staying = plan.members
    .filter((item) => String(item.userId) !== userId)
    .map((item) => ({ userId: item.userId, name: item.name, color: item.color, contributed: item.contributed || 0 }));
  if (staying.length === 0) {
    await plan.deleteOne();
    return;
  }
  plan.members.splice(0, plan.members.length);
  for (const person of staying) plan.members.push(person);
  if (String(plan.userId) === userId) plan.set('userId', staying[0].userId);
  if (!plan.tripActivity) plan.set('tripActivity', []);
  plan.tripActivity.push({
    at: new Date(),
    title: `${name} se ha salido`,
    body: `Ya no está en «${plan.name}».`,
    kind: 'left',
    settlementId: null,
  });
  await plan.save();
  const people = await User.find({ _id: { $in: staying.map((item) => item.userId) } }).select('_id');
  if (people.length === 0) return;
  await Notification.insertMany(people.map((person) => ({
    userId: person._id,
    quoteKey: `reparto:${plan._id}`,
    title: `${name} se ha salido`,
    body: `Ya no está en «${plan.name}».`,
    direction: 'due',
    changePct: null,
  })));
}

router.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const id = asId(req.params.id, 'El plan');
    const plan = await Plan.findOne({ _id: id, $or: [{ userId }, { 'members.userId': userId }] });
    if (!plan) throw new HttpError(404, 'Ese plan no existe.');
    if (plan.kind === 'gastos') {
      await leaveReparto(plan, userId);
      res.json({ ok: true });
      return;
    }
    if (String(plan.userId) !== userId) throw new HttpError(404, 'Ese plan no existe.');
    await plan.deleteOne();
    res.json({ ok: true });
  }),
);

function hideReceipts(plan: { toObject: () => Record<string, unknown> }) {
  const raw = plan.toObject();
  const expenses = raw.tripExpenses;
  if (!Array.isArray(expenses)) return raw;
  return {
    ...raw,
    tripExpenses: expenses.map((expense) => {
      const row = expense as { charge?: string; receipt?: string };
      return { ...row, receipt: row.charge === 'pending' ? row.receipt || '' : '' };
    }),
  };
}

async function chargeFull(userId: string, accountId: string, amount: number, name: string): Promise<string> {
  const account = await Account.findOne({ _id: accountId, userId });
  if (!account) throw new HttpError(404, 'Ese banco no está.');
  if (account.archived) throw new HttpError(400, 'Ese banco está archivado.');
  if (account.currency !== 'EUR') throw new HttpError(400, 'El tique se resta de una cuenta en euros.');
  const user = await User.findById(userId).select('timezone');
  const saved = await createMovement(userId, {
    type: 'expense',
    date: todayKey(user?.timezone || 'Europe/Madrid'),
    amount,
    currency: 'EUR',
    category: '',
    description: name,
    accountId,
    applyToBalances: true,
    confirmDuplicate: true,
  });
  return saved.id;
}

function moneyLabel(amount: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(amount);
}

function memberName(plan: { members: { userId: unknown; name: string }[] }, id: string): string {
  return plan.members.find((item) => String(item.userId) === id)?.name || 'Alguien';
}

async function tell(planId: string, userIds: string[], title: string, body: string) {
  const unique = [...new Set(userIds.map(String))].filter((id) => /^[a-f0-9]{24}$/i.test(id));
  if (unique.length === 0) return;
  const people = await User.find({ _id: { $in: unique } }).select('_id');
  if (people.length === 0) return;
  await Notification.insertMany(people.map((person) => ({
    userId: person._id,
    quoteKey: `reparto:${planId}`,
    title,
    body,
    direction: 'due',
    changePct: null,
  })));
}

function logActivity(plan: Awaited<ReturnType<typeof loadTrip>>, title: string, body: string, kind: string, settlementId: unknown = null) {
  plan.tripActivity.push({ at: new Date(), title, body, kind, settlementId });
}

router.post(
  '/:id/cerrar',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const plan = await loadTrip(userId, String(req.params.id));
    if (String(plan.userId) !== userId) throw new HttpError(403, 'Solo quien creó el reparto puede finalizarlo.');
    if (tripPhase(plan) !== 'active') throw new HttpError(400, 'Este reparto ya está cerrado.');
    const fresh = splitOf(plan);
    const kept = plan.settlements.filter((row) => row.status === 'confirmed');
    plan.settlements.splice(0, plan.settlements.length, ...kept);
    const now = new Date();
    for (const row of fresh.transfers) {
      plan.settlements.push({
        fromId: row.fromId,
        toId: row.toId,
        amount: row.amount,
        status: 'pending',
        openedAt: now,
        statusAt: now,
        paymentReportedAt: null,
        confirmedAt: null,
        reminded24: false,
        reminded72: false,
        events: [{ at: now, userId, action: 'created', note: 'Se ha generado el pago.' }],
      });
    }
    const pending = plan.settlements.filter((row) => row.status !== 'confirmed').length;
    plan.tripStatus = pending === 0 ? 'done' : 'settling';
    plan.tripClosedAt = now;
    const actor = memberName(plan, userId);
    const body = pending === 0 ? 'Nadie tiene que pagar nada. El reparto queda cerrado.' : pending === 1 ? 'Hay un pago pendiente.' : `Hay ${pending} pagos pendientes.`;
    logActivity(plan, `${actor} ha finalizado el plan`, body, 'finished');
    await plan.save();
    await tell(String(plan._id), plan.members.map((item) => String(item.userId)).filter((id) => id !== userId), `${actor} ha finalizado «${plan.name}»`, body);
    res.json({ ok: true, status: plan.tripStatus });
  }),
);

router.post(
  '/:id/reabrir',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const plan = await loadTrip(userId, String(req.params.id));
    if (String(plan.userId) !== userId) throw new HttpError(403, 'Solo quien creó el reparto puede reabrirlo.');
    if (tripPhase(plan) === 'active') throw new HttpError(400, 'Este reparto ya está abierto.');
    const kept = plan.settlements.filter((row) => row.status === 'confirmed');
    const dropped = plan.settlements.length - kept.length;
    plan.settlements.splice(0, plan.settlements.length, ...kept);
    plan.tripStatus = 'active';
    const actor = memberName(plan, userId);
    const body = dropped > 0
      ? 'Los pagos a medias se anulan. Las deudas se vuelven a calcular.'
      : 'Se pueden corregir los gastos. Las deudas se vuelven a calcular.';
    logActivity(plan, `${actor} ha reabierto el plan`, body, 'reopened');
    await plan.save();
    await tell(String(plan._id), plan.members.map((item) => String(item.userId)).filter((id) => id !== userId), `${actor} ha reabierto «${plan.name}»`, body);
    res.json({ ok: true });
  }),
);

function loadSettlement(plan: Awaited<ReturnType<typeof loadTrip>>, id: string) {
  const row = plan.settlements.find((item) => String(item._id) === id);
  if (!row) throw new HttpError(404, 'Esa liquidación no está.');
  return row;
}

router.post(
  '/:id/liquidacion/:sid/pagado',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const plan = await loadTrip(userId, String(req.params.id));
    if (tripPhase(plan) !== 'settling') throw new HttpError(400, 'El reparto no está en liquidación.');
    const row = loadSettlement(plan, String(req.params.sid || ''));
    if (String(row.fromId) !== userId) throw new HttpError(403, 'Solo quien tiene que pagar puede indicarlo.');
    if (row.status !== 'pending' && row.status !== 'disputed') throw new HttpError(400, 'Este pago no se puede marcar ahora.');
    const now = new Date();
    row.status = 'awaiting_confirmation';
    row.paymentReportedAt = now;
    row.statusAt = now;
    row.reminded24 = false;
    row.reminded72 = false;
    row.events.push({ at: now, userId, action: 'reported', note: 'Ha indicado que ya ha pagado.' });
    const actor = memberName(plan, userId);
    const receiver = memberName(plan, String(row.toId));
    const amount = moneyLabel(row.amount);
    logActivity(plan, `${actor} indica que ha pagado`, `${amount} a ${receiver}.`, 'reported', row._id);
    await plan.save();
    await tell(String(plan._id), [String(row.toId)], `${actor} indica que te ha pagado ${amount}`, `En «${plan.name}». ¿Has recibido el dinero?`);
    res.json({ ok: true });
  }),
);

router.post(
  '/:id/liquidacion/:sid/recibido',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const plan = await loadTrip(userId, String(req.params.id));
    if (tripPhase(plan) !== 'settling') throw new HttpError(400, 'El reparto no está en liquidación.');
    const row = loadSettlement(plan, String(req.params.sid || ''));
    if (String(row.toId) !== userId) throw new HttpError(403, 'Solo quien tiene que recibir puede confirmarlo.');
    if (String(row.fromId) === userId) throw new HttpError(403, 'No puedes confirmar un pago que te haces a ti.');
    if (row.status !== 'awaiting_confirmation') throw new HttpError(400, 'Todavía no hay un pago que confirmar.');
    const now = new Date();
    row.status = 'confirmed';
    row.confirmedAt = now;
    row.statusAt = now;
    row.reminded24 = false;
    row.reminded72 = false;
    row.events.push({ at: now, userId, action: 'confirmed', note: 'Ha confirmado que le ha llegado.' });
    const actor = memberName(plan, userId);
    const payer = memberName(plan, String(row.fromId));
    const amount = moneyLabel(row.amount);
    const closed = plan.settlements.every((item) => item.status === 'confirmed');
    if (closed) plan.tripStatus = 'done';
    logActivity(plan, `${actor} ha confirmado el pago`, `${payer} le ha pagado ${amount}.${closed ? ' El reparto está cerrado.' : ''}`, 'confirmed', row._id);
    await plan.save();
    await tell(String(plan._id), [String(row.fromId)], `${actor} ha confirmado el pago`, closed ? `${amount} recibidos. El reparto está cerrado.` : `${amount} recibidos.`);
    if (closed) {
      const rest = plan.members.map((item) => String(item.userId)).filter((id) => id !== userId && id !== String(row.fromId));
      await tell(String(plan._id), rest, `«${plan.name}» está cerrado`, 'Todos los pagos están confirmados.');
    }
    res.json({ ok: true, status: plan.tripStatus });
  }),
);

router.post(
  '/:id/liquidacion/:sid/no-recibido',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const plan = await loadTrip(userId, String(req.params.id));
    if (tripPhase(plan) !== 'settling') throw new HttpError(400, 'El reparto no está en liquidación.');
    const row = loadSettlement(plan, String(req.params.sid || ''));
    if (String(row.toId) !== userId) throw new HttpError(403, 'Solo quien tiene que recibir puede rechazarlo.');
    if (String(row.fromId) === userId) throw new HttpError(403, 'No puedes confirmar un pago que te haces a ti.');
    if (row.status !== 'awaiting_confirmation') throw new HttpError(400, 'Todavía no hay un pago que confirmar.');
    const now = new Date();
    row.status = 'disputed';
    row.statusAt = now;
    row.reminded24 = false;
    row.reminded72 = false;
    row.events.push({ at: now, userId, action: 'disputed', note: 'Ha dicho que no le ha llegado.' });
    const actor = memberName(plan, userId);
    const amount = moneyLabel(row.amount);
    logActivity(plan, `${actor} no ha recibido el pago`, `${amount} siguen pendientes.`, 'disputed', row._id);
    await plan.save();
    await tell(String(plan._id), [String(row.fromId)], `${actor} no ha recibido ${amount}`, `En «${plan.name}» el pago sigue abierto.`);
    res.json({ ok: true });
  }),
);

export default router;
