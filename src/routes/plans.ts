import { Router } from 'express';
import { Plan } from '../models/Plan.js';
import { Account } from '../models/Account.js';
import { User } from '../models/User.js';
import { Notification } from '../models/Notification.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { asyncRoute, HttpError } from '../http.js';
import { asDay, asId, asMoney, asOptionalMoney, asPicture, asText } from '../validate.js';
import { roundMoney, todayKey } from '../domain/finance.js';
import { forecastForPlan } from '../services/ledger.js';
import { listDueFixed, remindDuePayments } from '../services/plan-reminders.js';

const router = Router();
router.use(authenticateToken);

function owner(req: AuthRequest) {
  return req.userId as string;
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
    await remindDuePayments(userId);
    const plans = await Plan.find({ userId }).sort({ createdAt: -1 });
    const withForecast = [];
    for (const plan of plans) {
      const forecast = await forecastForPlan(plan, userId);
      withForecast.push({ plan, forecast });
    }
    res.json({ plans: withForecast });
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
    const plan = await Plan.create({ userId, ...readPlan(req.body || {}) });
    await remindDuePayments(userId);
    const forecast = await forecastForPlan(plan, userId);
    res.status(201).json({ plan, forecast });
  }),
);

router.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const plan = await Plan.findOneAndUpdate({ _id: asId(req.params.id, 'El plan'), userId }, readPlan(req.body || {}), {
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

router.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const deleted = await Plan.findOneAndDelete({ _id: asId(req.params.id, 'El plan'), userId: owner(req as AuthRequest) });
    if (!deleted) throw new HttpError(404, 'Ese plan no existe.');
    res.json({ ok: true });
  }),
);

export default router;
