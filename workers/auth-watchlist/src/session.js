/** Bearer session JWT. Not a cookie — Pages and workers.dev are different sites. */

import { signHmacJwt, verifyHmacJwt } from "./jwt.js";

const DEFAULT_TTL = 7 * 24 * 60 * 60;
const MIN_TTL = 5 * 60;
const MAX_TTL = 14 * 24 * 60 * 60;

export function sessionSecret(env) {
  const raw = env && env.SESSION_SECRET ? String(env.SESSION_SECRET).trim() : "";
  if (raw.length < 16) return "";
  return raw;
}

export function sessionTtl(env) {
  const n = Number(env && env.SESSION_TTL_SECONDS);
  if (!Number.isFinite(n) || n < MIN_TTL) return DEFAULT_TTL;
  return Math.min(Math.floor(n), MAX_TTL);
}

export async function issueSession(secret, userId, jti, nowSeconds, ttl) {
  const iat = nowSeconds;
  const exp = nowSeconds + ttl;
  const token = await signHmacJwt(secret, {
    sub: userId,
    jti: jti,
    iat: iat,
    exp: exp,
    ver: 1,
  });
  return { token: token, exp: exp };
}

export async function readSession(secret, token, nowSeconds) {
  if (!secret) return null;
  const raw = String(token || "").trim();
  if (!raw || raw.length > 4000) return null;
  let payload;
  try {
    payload = await verifyHmacJwt(secret, raw);
  } catch (e) {
    return null;
  }
  if (!payload) return null;
  const exp = Number(payload.exp);
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const jti = typeof payload.jti === "string" ? payload.jti : "";
  if (!sub || !jti || !Number.isFinite(exp) || exp <= nowSeconds) return null;
  if (payload.ver !== 1) return null;
  return { userId: sub, jti: jti, exp: exp };
}

export function bearerToken(request) {
  const header = String(request.headers.get("authorization") || "");
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return "";
  return match[1].trim();
}
