export type PayState = 'pending' | 'claimed' | 'done';

export interface PayRow {
  fromId: string;
  toId: string;
  amount: number;
  state: PayState;
  rejected: boolean;
}

export interface PayAsk {
  fromId: string;
  toId: string;
  amount: number;
  role: 'pay' | 'confirm';
  otherName: string;
  rejected: boolean;
}

export function euros(value: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value);
}

/** El que debe dice que ha pagado. El que cobra confirma o lo devuelve. */
export function applyPay(row: PayRow, actorId: string, action: 'paid' | 'yes' | 'no'): PayRow | null {
  if (action === 'paid') {
    if (actorId !== row.fromId || row.state !== 'pending') return null;
    return { ...row, state: 'claimed', rejected: false };
  }
  if (actorId !== row.toId || row.state !== 'claimed') return null;
  if (action === 'yes') return { ...row, state: 'done', rejected: false };
  return { ...row, state: 'pending', rejected: true };
}

/** Primero un pago rechazado, luego lo que hay que confirmar, luego lo que aún no se ha pagado. */
export function payAsks(userId: string, pays: PayRow[], names: Map<string, string>): PayAsk[] {
  const ask = (row: PayRow, role: 'pay' | 'confirm'): PayAsk => ({
    fromId: row.fromId,
    toId: row.toId,
    amount: row.amount,
    role,
    otherName: names.get(role === 'pay' ? row.toId : row.fromId) || 'Alguien',
    rejected: row.rejected,
  });
  const mine = pays.map((row) => ({
    fromId: String(row.fromId),
    toId: String(row.toId),
    amount: Number(row.amount),
    state: row.state,
    rejected: Boolean(row.rejected),
  }));
  return [
    ...mine.filter((row) => row.state === 'pending' && row.rejected && row.fromId === userId).map((row) => ask(row, 'pay')),
    ...mine.filter((row) => row.state === 'claimed' && row.toId === userId).map((row) => ask(row, 'confirm')),
    ...mine.filter((row) => row.state === 'pending' && !row.rejected && row.fromId === userId).map((row) => ask(row, 'pay')),
  ];
}

export function closingNote(
  planName: string,
  userId: string,
  people: { id: string; net: number }[],
  transfers: { fromId: string; toId: string; from: string; to: string; amount: number }[],
): { title: string; body: string } {
  const me = people.find((person) => person.id === userId);
  const parts = transfers
    .filter((row) => row.fromId === userId || row.toId === userId)
    .map((row) => (row.fromId === userId ? `Debes ${euros(row.amount)} a ${row.to}` : `${row.from} te debe ${euros(row.amount)}`));
  if (!me || Math.abs(me.net) < 0.005) {
    return { title: 'Estás en paz', body: `En «${planName}» no pagas ni te pagan.` };
  }
  const title = me.net < 0 ? `Debes ${euros(-me.net)}` : `Te deben ${euros(me.net)}`;
  return { title, body: parts.length ? `«${planName}». ${parts.join('. ')}.` : `«${planName}».` };
}
