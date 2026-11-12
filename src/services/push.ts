import mongoose from 'mongoose';
import webpush from 'web-push';
import { PushSub } from '../models/PushSub.js';
import { Notification } from '../models/Notification.js';
import { Watch } from '../models/Watch.js';
import { offerIdentity } from './watches.js';

function pair() {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey };
}

let ready = false;
let warned = false;

function prepare(): boolean {
  const keys = pair();
  if (!keys) {
    if (!warned) {
      warned = true;
      console.error('push: faltan VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY. El móvil no recibirá avisos.');
    }
    return false;
  }
  if (!ready) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || 'mailto:avisos@balance.app', keys.publicKey, keys.privateKey);
    ready = true;
  }
  return true;
}

export function pushPublicKey(): string | null {
  return pair()?.publicKey ?? null;
}

export type PushResult = { sent: number; removed: number; error: 'sin-claves' | 'sin-dispositivo' | 'caducado' | 'rechazado' | null };

function sameUser(userId: string) {
  const ids: Array<string | mongoose.Types.ObjectId> = [userId];
  if (mongoose.isValidObjectId(userId)) ids.push(new mongoose.Types.ObjectId(userId));
  return { userId: { $in: ids } };
}

export async function sendToUser(userId: string, payload: { title: string; body: string; url?: string | null; image?: string | null; tag?: string | null }): Promise<PushResult> {
  if (!prepare()) return { sent: 0, removed: 0, error: 'sin-claves' };
  const subs = await PushSub.find(sameUser(userId));
  if (!subs.length) return { sent: 0, removed: 0, error: 'sin-dispositivo' };
  let sent = 0;
  let removed = 0;
  let error: PushResult['error'] = null;
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({
          title: payload.title,
          body: payload.body,
          url: payload.url || '/',
          image: payload.image || '',
          tag: payload.tag || '',
        }),
        { TTL: 12 * 60 * 60, urgency: 'high' },
      );
      sent += 1;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const detail = err instanceof Error ? err.message : 'rechazado';
      if (status === 404 || status === 410 || status === 401 || status === 403) {
        await sub.deleteOne();
        removed += 1;
        error = error || 'caducado';
      } else {
        error = error || 'rechazado';
        console.error('push', status || '', detail);
      }
    }
  }));
  return { sent, removed, error: sent > 0 ? null : error };
}

export function pushFailure(error: PushResult['error']): string {
  if (error === 'sin-claves') return 'El servidor todavía no puede mandar avisos al móvil.';
  if (error === 'sin-dispositivo') return 'Este móvil no ha quedado registrado.';
  if (error === 'caducado') return 'Este móvil ha caducado el aviso. Vuelve a activarlo.';
  return 'El servicio de avisos del móvil ha rechazado el envío.';
}

const PENDING_MS = 12 * 60 * 60 * 1000;

/** Al activar un móvil nuevo, manda la última oferta sin leer si su aviso sigue puesto y no se ha descartado. */
export async function pushPendingOffers(userId: string): Promise<number> {
  const note = await Notification.findOne({
    ...sameUser(userId),
    quoteKey: /^listing:/,
    read: { $ne: true },
    createdAt: { $gte: new Date(Date.now() - PENDING_MS) },
  }).sort({ createdAt: -1 });
  if (!note) return 0;
  const identity = offerIdentity(note.quoteKey);
  if (!identity) return 0;
  const live = await Watch.exists({ _id: identity.watchId, enabled: { $ne: false }, passedIds: { $ne: identity.askId } });
  if (!live) return 0;
  const result = await sendToUser(userId, { title: note.title, body: note.body, url: note.url, image: note.image, tag: note.quoteKey });
  return result.sent;
}
