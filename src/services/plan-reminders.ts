import { addDays, forecastReached, todayKey } from '../domain/finance.js';
import { Notification } from '../models/Notification.js';
import { Plan } from '../models/Plan.js';
import { User } from '../models/User.js';

async function finishedPlanIds(userId: string): Promise<Set<string>> {
  const { forecastPlanList } = await import('./ledger.js');
  const plans = await Plan.find({ userId });
  const rows = await forecastPlanList(userId, plans);
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.plan.kind === 'gastos') continue;
    if (forecastReached(row.forecast, row.plan.openingBalance, row.plan.targetAmount)) ids.add(String(row.plan._id));
  }
  return ids;
}

async function clearFinishedDues(userId: string, planId: string): Promise<void> {
  await Notification.deleteMany({ userId, quoteKey: { $regex: `^plan-due:${planId}:` } });
}

function daysBetween(from: string, to: string): number {
  const [ay, am, ad] = from.split('-').map(Number);
  const [by, bm, bd] = to.split('-').map(Number);
  return Math.round((Date.UTC(by, (bm || 1) - 1, bd || 1) - Date.UTC(ay, (am || 1) - 1, ad || 1)) / 86_400_000);
}

function inWindow(date: string, today: string): boolean {
  if (date > today) return false;
  return daysBetween(date, today) <= 7;
}

function euros(amount: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(amount);
}

function dayLabel(date: string): string {
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const [year, month, day] = date.slice(0, 10).split('-').map(Number);
  return `${day || 1} ${months[(month || 1) - 1]} ${year || ''}`.trim();
}

async function ensureDue(userId: string, key: string, title: string, body: string): Promise<void> {
  const exists = await Notification.findOne({ userId, quoteKey: key });
  if (!exists) {
    await Notification.create({ userId, quoteKey: key, title, body, direction: 'due', changePct: null });
    return;
  }
  if (exists.title !== title || exists.body !== body) {
    exists.title = title;
    exists.body = body;
    await exists.save();
  }
}

const remindPending = new Map<string, Promise<void>>();
const remindDoneAt = new Map<string, number>();

export function remindDuePayments(userId: string): Promise<void> {
  const doneAt = remindDoneAt.get(userId) || 0;
  if (Date.now() - doneAt < 20_000) return Promise.resolve();
  const pending = remindPending.get(userId);
  if (pending) return pending;
  const job = runReminders(userId)
    .then(() => {
      remindDoneAt.set(userId, Date.now());
    })
    .finally(() => {
      remindPending.delete(userId);
    });
  remindPending.set(userId, job);
  return job;
}

async function runReminders(userId: string): Promise<void> {
  const user = await User.findById(userId).select('timezone');
  const today = todayKey(user?.timezone || 'Europe/Madrid');
  const plans = await Plan.find({ userId });
  const finished = await finishedPlanIds(userId);
  for (const plan of plans) {
    if (plan.kind === 'gastos') continue;
    const start = plan.startDate.slice(0, 10);
    let dirty = false;
    for (const expense of plan.plannedExpenses) {
      if (/^entrenador$/i.test(expense.name) && expense.automatic !== true) {
        expense.automatic = true;
        dirty = true;
      }
    }
    if (dirty) await plan.save();
    if (finished.has(String(plan._id))) continue;
    const dues: { key: string; title: string; body: string; direction: 'up' | 'down' | 'due' }[] = [];
    const happened = (key: string, incoming: boolean, amount: number, label: string) => {
      dues.push({
        key,
        title: incoming ? `Han entrado ${euros(amount)}` : `Han salido ${euros(amount)}`,
        body: `${label} · ${plan.name}`,
        direction: incoming ? 'up' : 'down',
      });
    };
    for (const expense of plan.plannedExpenses) {
      const date = String(expense.date).slice(0, 10);
      const fixed = expense.automatic === true;
      if (fixed) {
        const confirmed = (plan.settled || []).some((item) => item.key === `expense:${expense._id}` && item.done);
        if (confirmed && date <= today && inWindow(date, today)) happened(`plan-auto:${plan._id}:expense:${expense._id}`, false, expense.amount, expense.name);
        continue;
      }
      if (expense.paid || !inWindow(date, today)) continue;
      dues.push({
        key: `plan-due:${plan._id}:expense:${expense._id}`,
        title: `Te toca pagar ${expense.name}`,
        body: `${plan.name} · ${euros(expense.amount)}`,
        direction: 'due',
      });
    }
    if (plan.monthlySavings > 0) {
      const anchor = plan.savingsDay && plan.savingsDay >= 1 && plan.savingsDay <= 31 ? Math.round(plan.savingsDay) : 31;
      const label = (plan.salary || 0) > 0 ? 'Nómina · parte ahorro' : 'Ahorro del mes';
      for (const back of [0, 31]) {
        const probe = addDays(today, -back).slice(0, 7);
        const dim = new Date(Date.UTC(Number(probe.slice(0, 4)), Number(probe.slice(5, 7)), 0)).getUTCDate();
        const date = `${probe}-${String(Math.min(anchor, dim)).padStart(2, '0')}`;
        if (date <= start || (plan.savingsSkipped || []).includes(date)) continue;
        const confirmed = (plan.settled || []).some((item) => item.key === `savings:${date}` && item.done);
        if (date > today || !inWindow(date, today)) continue;
        if (confirmed) happened(`plan-auto:${plan._id}:savings:${date}`, true, plan.monthlySavings, label);
        else {
          dues.push({
            key: `plan-due:${plan._id}:savings:${date}`,
            title: `Hoy toca apartar ${euros(plan.monthlySavings)}`,
            body: `${plan.name} · confirma el ahorro`,
            direction: 'due',
          });
        }
      }
    }
    const dim = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
    for (const item of plan.recurring) {
      const dueDay = Math.min(Math.max(1, item.dayOfMonth), dim);
      const date = `${today.slice(0, 7)}-${String(dueDay).padStart(2, '0')}`;
      if (date < start || date > today || !inWindow(date, today)) continue;
      const confirmed = (plan.settled || []).some((row) => row.key === `recurring:${item._id}:${date}` && row.done);
      if (confirmed) happened(`plan-auto:${plan._id}:recurring:${item._id}:${date}`, item.direction === 'in', item.amount, item.name);
      else dues.push({
        key: `plan-due:${plan._id}:recurring:${item._id}:${date}`,
        title: item.direction === 'in' ? `¿Ha entrado ${item.name}?` : `¿Has pagado ${item.name}?`,
        body: `${plan.name} · ${euros(item.amount)} · ${dayLabel(date)}`,
        direction: 'due',
      });
    }
    for (const item of plan.intervals || []) {
      const anchor = String(item.startDate).slice(0, 10);
      const every = Math.max(1, Math.round(item.everyWeeks || 1)) * 7;
      for (let back = 0; back <= 7; back += 1) {
        const date = addDays(today, -back);
        if (date < start || date < anchor) continue;
        if (daysBetween(anchor, date) % every !== 0) continue;
        const confirmed = (plan.settled || []).some((row) => row.key === `interval:${item._id}:${date}` && row.done);
        if (confirmed) happened(`plan-auto:${plan._id}:interval:${item._id}:${date}`, item.direction === 'in', item.amount, item.name);
        else dues.push({
          key: `plan-due:${plan._id}:interval:${item._id}:${date}`,
          title: item.direction === 'in' ? `¿Ha entrado ${item.name}?` : `¿Has pagado ${item.name}?`,
          body: `${plan.name} · ${euros(item.amount)} · ${dayLabel(date)}`,
          direction: 'due',
        });
        break;
      }
    }
    for (const due of dues) {
      if (due.direction === 'due') await ensureDue(userId, due.key, due.title, due.body);
      else if (!(await Notification.exists({ userId, quoteKey: due.key }))) {
        await Notification.create({
          userId,
          quoteKey: due.key,
          title: due.title,
          body: due.body,
          direction: due.direction,
          changePct: null,
        });
      }
    }
  }
  const pending = await listDueFixed(userId);
  for (const due of pending) {
    await ensureDue(
      userId,
      `plan-due:${due.planId}:${due.key}`,
      due.direction === 'in' ? `¿Ha entrado ${due.label}?` : `¿Has pagado ${due.label}?`,
      `${due.planName} · ${euros(due.amount)} · ${dayLabel(due.day)}`,
    );
  }
  await remindTripPayments(userId);
}

async function remindTripPayments(userId: string): Promise<void> {
  const plans = await Plan.find({ kind: 'gastos', tripStatus: 'settling', 'members.userId': userId });
  const now = Date.now();
  const money = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
  for (const plan of plans) {
    let dirty = false;
    for (const row of plan.settlements || []) {
      if (row.status === 'confirmed') continue;
      const actor = row.status === 'awaiting_confirmation' ? String(row.toId) : String(row.fromId);
      if (actor !== userId) continue;
      const since = new Date(row.statusAt || row.openedAt || now).getTime();
      const hours = (now - since) / 3_600_000;
      const otherId = row.status === 'awaiting_confirmation' ? String(row.fromId) : String(row.toId);
      const other = plan.members.find((item) => String(item.userId) === otherId)?.name || 'alguien';
      const amount = money.format(row.amount);
      const stamp = `${row.status}:${String(row.statusAt || row.openedAt || '')}`;
      if (hours >= 24 && !row.reminded24) {
        const title = row.status === 'awaiting_confirmation' ? `${other} sigue esperando que confirmes` : `Pago pendiente en ${plan.name}`;
        const body = row.status === 'awaiting_confirmation' ? `${other} indicó un pago de ${amount}. ¿Te ha llegado?` : `Tienes que pagar ${amount} a ${other}.`;
        await ensureDue(userId, `trip-remind:${plan._id}:${row._id}:${stamp}:24`, title, body);
        row.reminded24 = true;
        dirty = true;
      }
      if (hours >= 72 && !row.reminded72) {
        const title = row.status === 'awaiting_confirmation' ? `Confirma si te ha llegado el pago de ${other}` : `Sigue pendiente el pago a ${other}`;
        const body = `${plan.name} · ${amount}.`;
        await ensureDue(userId, `trip-remind:${plan._id}:${row._id}:${stamp}:72`, title, body);
        row.reminded72 = true;
        dirty = true;
      }
    }
    if (dirty) await plan.save();
  }
}

export interface DuePrompt {
  planId: string;
  planName: string;
  key: string;
  label: string;
  amount: number;
  direction: 'in' | 'out';
  day: string;
}

function monthSpan(start: string, today: string): string[] {
  const months: string[] = [];
  let cursor = start.slice(0, 7);
  const stop = today.slice(0, 7);
  let guard = 0;
  while (cursor <= stop && guard < 48) {
    months.push(cursor);
    const [year, month] = cursor.split('-').map(Number);
    cursor = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
    guard += 1;
  }
  return months;
}

function monthDate(month: string, anchor: number): string {
  const [year, index] = month.split('-').map(Number);
  const dim = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return `${month}-${String(Math.min(anchor, dim)).padStart(2, '0')}`;
}

/** Fijos cuyo día ya pasó y todavía no se han confirmado. */
export async function listDueFixed(userId: string): Promise<DuePrompt[]> {
  const user = await User.findById(userId).select('timezone');
  const today = todayKey(user?.timezone || 'Europe/Madrid');
  const plans = await Plan.find({ userId });
  const finished = await finishedPlanIds(userId);
  const prompts: DuePrompt[] = [];
  for (const plan of plans) {
    if (finished.has(String(plan._id))) {
      await clearFinishedDues(userId, String(plan._id));
      continue;
    }
    const start = plan.startDate.slice(0, 10);
    const known = new Set((plan.settled || []).map((item) => item.key));
    const anchor = plan.savingsDay && plan.savingsDay >= 1 && plan.savingsDay <= 31 ? Math.round(plan.savingsDay) : 31;
    if (plan.monthlySavings > 0) {
      const label = (plan.salary || 0) > 0 ? 'Nómina · parte ahorro' : 'Ahorro del mes';
      for (const month of monthSpan(start, today)) {
        const day = monthDate(month, anchor);
        const key = `savings:${day}`;
        if (day <= start || day > today || (plan.savingsSkipped || []).includes(day) || known.has(key)) continue;
        prompts.push({ planId: String(plan._id), planName: plan.name, key, label, amount: plan.monthlySavings, direction: 'in', day });
      }
    }
    for (const expense of plan.plannedExpenses) {
      const automatic = expense.automatic === true || /^entrenador$/i.test(expense.name || '');
      if (!automatic) continue;
      const day = String(expense.date).slice(0, 10);
      const key = `expense:${expense._id}`;
      if (day < start || day > today || known.has(key)) continue;
      prompts.push({ planId: String(plan._id), planName: plan.name, key, label: expense.name, amount: expense.amount, direction: 'out', day });
    }
    for (const month of monthSpan(start, today)) {
      for (const item of plan.recurring) {
        const day = monthDate(month, item.dayOfMonth);
        const key = `recurring:${item._id}:${day}`;
        if (day < start || day > today || known.has(key)) continue;
        prompts.push({ planId: String(plan._id), planName: plan.name, key, label: item.name, amount: item.amount, direction: item.direction === 'in' ? 'in' : 'out', day });
      }
    }
    for (const item of plan.intervals || []) {
      const anchorDay = String(item.startDate).slice(0, 10);
      const every = Math.max(1, Math.round(item.everyWeeks || 1)) * 7;
      for (let day = anchorDay; day <= today; day = addDays(day, every)) {
        if (day < start || daysBetween(anchorDay, day) % every !== 0) continue;
        const key = `interval:${item._id}:${day}`;
        if (known.has(key)) continue;
        prompts.push({ planId: String(plan._id), planName: plan.name, key, label: item.name, amount: item.amount, direction: item.direction === 'in' ? 'in' : 'out', day });
      }
    }
  }
  return prompts.sort((a, b) => a.day.localeCompare(b.day) || a.label.localeCompare(b.label)).slice(0, 8);
}
