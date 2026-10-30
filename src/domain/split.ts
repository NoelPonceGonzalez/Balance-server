export interface SplitPerson {
  id: string;
  name: string;
  color: string;
  contributed: number;
}

export interface SplitExpense {
  paidBy: string;
  amount: number;
  /** Vacío: se reparte entre todas las personas que siguen en el plan. */
  splitAmong?: string[];
}

export interface SplitResult {
  totalSpent: number;
  people: {
    id: string;
    name: string;
    color: string;
    contributed: number;
    spent: number;
    share: number;
    net: number;
  }[];
  transfers: { fromId: string; from: string; toId: string; to: string; amount: number }[];
}

function cents(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

function give(amount: number, targets: string[], rank: (id: string) => number): Map<string, number> {
  const owed = new Map<string, number>();
  if (targets.length === 0 || amount <= 0) return owed;
  const base = Math.trunc(amount / targets.length);
  let rest = amount - base * targets.length;
  for (const id of targets) owed.set(id, base);
  const order = [...targets].sort((a, b) => rank(b) - rank(a) || targets.indexOf(a) - targets.indexOf(b));
  for (const id of order) {
    if (rest <= 0) break;
    owed.set(id, (owed.get(id) || 0) + 1);
    rest -= 1;
  }
  return owed;
}

export function transfersOf(people: { id: string; name: string; net: number }[]): SplitResult['transfers'] {
  const debtors = people.filter((person) => cents(person.net) < 0).map((person) => ({ ...person, left: -cents(person.net) }));
  const creditors = people.filter((person) => cents(person.net) > 0).map((person) => ({ ...person, left: cents(person.net) }));
  debtors.sort((a, b) => b.left - a.left);
  creditors.sort((a, b) => b.left - a.left);
  const transfers: SplitResult['transfers'] = [];
  let debtor = 0;
  let creditor = 0;
  while (debtor < debtors.length && creditor < creditors.length) {
    const pay = Math.min(debtors[debtor].left, creditors[creditor].left);
    if (pay > 0) {
      transfers.push({
        fromId: debtors[debtor].id,
        from: debtors[debtor].name,
        toId: creditors[creditor].id,
        to: creditors[creditor].name,
        amount: pay / 100,
      });
    }
    debtors[debtor].left -= pay;
    creditors[creditor].left -= pay;
    if (debtors[debtor].left === 0) debtor += 1;
    if (creditors[creditor].left === 0) creditor += 1;
  }
  return transfers;
}

/** Lo puesto más lo pagado. Cada gasto se reparte entre las personas elegidas, o entre todas. */
export function splitTrip(members: SplitPerson[], expenses: SplitExpense[]): SplitResult {
  const ids = members.map((member) => member.id);
  const known = new Set(ids);
  const contributed = new Map<string, number>();
  const spent = new Map<string, number>();
  for (const member of members) {
    contributed.set(member.id, Math.max(0, cents(member.contributed)));
    spent.set(member.id, 0);
  }
  let totalSpent = 0;
  const slices: { amount: number; targets: string[] }[] = [];
  for (const expense of expenses) {
    const amount = cents(expense.amount);
    if (amount <= 0) continue;
    totalSpent += amount;
    if (known.has(expense.paidBy)) spent.set(expense.paidBy, (spent.get(expense.paidBy) || 0) + amount);
    const chosen = (expense.splitAmong || []).filter((id) => known.has(id));
    slices.push({ amount, targets: chosen.length > 0 ? chosen : ids });
  }
  const credit = (id: string) => (contributed.get(id) || 0) + (spent.get(id) || 0);
  const owed = new Map<string, number>(ids.map((id) => [id, 0]));
  const add = (amount: number, targets: string[]) => {
    for (const [id, share] of give(amount, targets, credit)) owed.set(id, (owed.get(id) || 0) + share);
  };
  for (const slice of slices) add(slice.amount, slice.targets);
  add([...contributed.values()].reduce((sum, value) => sum + value, 0), ids);
  const people = members.map((member) => {
    const put = contributed.get(member.id) || 0;
    const paid = spent.get(member.id) || 0;
    const share = owed.get(member.id) || 0;
    return {
      id: member.id,
      name: member.name,
      color: member.color,
      contributed: put / 100,
      spent: paid / 100,
      share: share / 100,
      net: (put + paid - share) / 100,
    };
  });
  return { totalSpent: totalSpent / 100, people, transfers: transfersOf(people) };
}

/** Un pago ya confirmado reduce lo que queda por saldar, sin tocar lo que cada persona debía al principio. */
export function netsAfterConfirmed<T extends { id: string; net: number }>(people: T[], confirmed: { fromId: string; toId: string; amount: number }[]): T[] {
  const nets = new Map(people.map((person) => [person.id, cents(person.net)]));
  for (const row of confirmed) {
    const amount = cents(row.amount);
    if (amount <= 0) continue;
    if (nets.has(row.fromId)) nets.set(row.fromId, (nets.get(row.fromId) || 0) + amount);
    if (nets.has(row.toId)) nets.set(row.toId, (nets.get(row.toId) || 0) - amount);
  }
  return people.map((person) => ({ ...person, net: (nets.get(person.id) || 0) / 100 }));
}
