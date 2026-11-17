import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { HttpError } from '../http.js';

const ORIGINS = new Set([
  'https://balance-client.vercel.app',
  'http://localhost:5181',
  'http://127.0.0.1:5181',
]);

type StoredPasskey = {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
};

type PasskeyUser = {
  _id: unknown;
  name: string;
  username?: string | null;
  email: string;
  passkeys?: StoredPasskey[];
  passkey?: boolean;
  passkeyChallenge?: string;
  passkeyChallengeAt?: Date | null;
  save: () => Promise<unknown>;
  markModified: (path: string) => void;
};

export function passkeyContext(originHeader: string | undefined) {
  const origin = originHeader || '';
  if (!ORIGINS.has(origin)) throw new HttpError(400, 'Este sitio no puede usar la huella.');
  return { origin, rpID: new URL(origin).hostname };
}

function rememberChallenge(user: PasskeyUser, challenge: string) {
  user.passkeyChallenge = challenge;
  user.passkeyChallengeAt = new Date();
}

function takeChallenge(user: PasskeyUser) {
  const challenge = user.passkeyChallenge || '';
  const at = user.passkeyChallengeAt ? new Date(user.passkeyChallengeAt).getTime() : 0;
  user.passkeyChallenge = '';
  user.passkeyChallengeAt = null;
  if (!challenge || Date.now() - at > 2 * 60 * 1000) {
    throw new HttpError(400, 'La huella ha caducado. Vuelve a probarlo.');
  }
  return challenge;
}

export async function registrationOptions(user: PasskeyUser, originHeader: string | undefined) {
  const { rpID } = passkeyContext(originHeader);
  const options = await generateRegistrationOptions({
    rpName: 'Balance',
    rpID,
    userName: user.username || user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(String(user._id)),
    attestationType: 'none',
    preferredAuthenticatorType: 'localDevice',
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      userVerification: 'required',
    },
    excludeCredentials: (user.passkeys || []).map((item) => ({ id: item.id, transports: item.transports })),
  });
  rememberChallenge(user, options.challenge);
  await user.save();
  return options;
}

export async function storeRegistration(user: PasskeyUser, body: RegistrationResponseJSON, originHeader: string | undefined) {
  const { origin, rpID } = passkeyContext(originHeader);
  const expectedChallenge = takeChallenge(user);
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    await user.save();
    throw new HttpError(401, 'No se ha podido guardar la huella.');
  }
  if (!verified.verified) {
    await user.save();
    throw new HttpError(401, 'No se ha podido guardar la huella.');
  }
  const credential = verified.registrationInfo.credential;
  const already = (user.passkeys || []).some((item) => item.id === credential.id);
  if (!already) {
    user.passkeys = [...(user.passkeys || []), {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: body.response.transports || credential.transports || [],
    }];
    user.markModified('passkeys');
  }
  user.passkey = true;
  await user.save();
}

export async function authenticationOptions(user: PasskeyUser, originHeader: string | undefined) {
  const { rpID } = passkeyContext(originHeader);
  const keys = user.passkeys || [];
  if (!keys.length) throw new HttpError(400, 'En este teléfono todavía no hay huella.');
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: keys.map((item) => ({ id: item.id, transports: item.transports })),
  });
  rememberChallenge(user, options.challenge);
  await user.save();
  return options;
}

export async function openWithPasskey(user: PasskeyUser, body: AuthenticationResponseJSON, originHeader: string | undefined) {
  const { origin, rpID } = passkeyContext(originHeader);
  const expectedChallenge = takeChallenge(user);
  const stored = (user.passkeys || []).find((item) => item.id === body.id);
  if (!stored) {
    await user.save();
    throw new HttpError(401, 'La huella no coincide.');
  }
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: stored.id,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
        counter: stored.counter || 0,
        transports: stored.transports,
      },
    });
  } catch {
    await user.save();
    throw new HttpError(401, 'La huella no coincide.');
  }
  if (!verified.verified || !verified.authenticationInfo.userVerified) {
    await user.save();
    throw new HttpError(401, 'La huella no coincide.');
  }
  stored.counter = verified.authenticationInfo.newCounter;
  user.markModified('passkeys');
  await user.save();
}
