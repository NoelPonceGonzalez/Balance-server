import webpush from 'web-push';
import { PushSub } from '../models/PushSub.js';
import { Notification } from '../models/Notification.js';

function pair() {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey };
}

let ready = false;

function prepare(): boolean {
  const keys = pair();
  if (!keys) return false;
  if (!ready) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || 'mailto:avisos@balance.app', keys.publicKey, keys.privateKey);
    ready = true;
  }
  return true;
}

export function pushPublicKey(): string | null {
  return pair()?.publicKey ?? null;
}

export async function sendToUser(userId: string, payload: { title: string; body: string; url?: string | null }): Promise<number> {
  if (!prepare()) return 0;
  const subs = await PushSub.find({ userId });
  let sent = 0;
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title: payload.title, body: payload.body, url: payload.url || '/' }),
      );
      sent += 1;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await sub.deleteOne();
      else console.error('push', error instanceof Error ? error.message : error);
    }
  }));
  return sent;
}

/** Al activar el móvil, manda el aviso de compra que sigue pendiente. */
export async function pushPendingOffers(userId: string): Promise<number> {
  const note = await Notification.findOne({ userId, quoteKey: /^listing:/ }).sort({ createdAt: -1 });
  if (!note) return 0;
  return sendToUser(userId, { title: note.title, body: note.body, url: note.url });
}
