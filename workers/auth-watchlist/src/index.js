/**
 * Checker login + personal watchlist.
 * Verifies a Google ID token, then issues a short-lived Bearer JWT.
 * D1 stores the account and product codes only. Prices stay in the Pages bundle.
 * v1 is Google only. provider "apple" is reserved in the schema and rejected here.
 * No password accounts. No delete-account route in v1.
 */
import { normalizeProductCode, watchlistMax } from "./codes.js";
import { clearJwksCache, verifyGoogleIdToken } from "./providers.js";
import { bearerToken, issueSession, readSession, sessionSecret, sessionTtl } from "./session.js";

export { clearJwksCache };

const PAGES_ORIGIN = "https://francischeung11240518.github.io";

const MESSAGES = {
  auth_disabled: "登入未開放。",
  origin: "來源網址不在允許清單。",
  method: "不支援呢個方法。",
  bad_request: "請求不正確。",
  apple_disabled: "第一版只支援 Google 登入。",
  bad_token: "登入核實失敗。",
  not_configured: "登入未設定完成。",
  db_unconfigured: "未設定追蹤資料庫。",
  unauthorized: "請先登入。",
  limit: "追蹤上限係 50 件。",
  bad_code: "產品編號不正確。",
  not_found: "搵唔到呢個位址。",
  upstream: "暫時未能核實登入。",
};

function killSwitchEnabled(value) {
  const v = String(value == null ? "" : value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export function originAllowed(origin) {
  if (!origin) return { ok: true, browser: false };
  let url;
  try {
    url = new URL(origin);
  } catch (e) {
    return { ok: false, browser: true };
  }
  if (url.origin === PAGES_ORIGIN) return { ok: true, browser: true };
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (localHost && (url.protocol === "http:" || url.protocol === "https:")) {
    return { ok: true, browser: true };
  }
  return { ok: false, browser: true };
}

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "600",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    }, corsHeaders(origin)),
  });
}

function audit(entry) {
  console.log(JSON.stringify({
    audit: "auth-watchlist",
    ts: new Date().toISOString(),
    ok: entry.ok === true,
    op: entry.op || "",
    error: entry.error ? String(entry.error) : "",
    provider: entry.provider || "",
  }));
}

function fail(error, status, origin, extra) {
  audit({
    ok: false,
    op: extra && extra.op || "",
    error: error,
    provider: extra && extra.provider || "",
  });
  return json({
    ok: false,
    error: error,
    message: MESSAGES[error] || MESSAGES.upstream,
  }, status, origin);
}

function publicClientId(value) {
  const s = String(value || "").trim();
  if (!s || s.length > 200) return "";
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return "";
  return s;
}

function dbReady(env) {
  return !!(env && env.DB && typeof env.DB.prepare === "function");
}

function isoSeconds(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return "";
  return new Date(n * 1000).toISOString();
}

function userView(row) {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name || "",
    email: row.email || "",
  };
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || "0");
  if (declared > 16384) return { error: "bad_request" };
  const buf = await request.arrayBuffer();
  if (buf.byteLength > 16384) return { error: "bad_request" };
  if (!buf.byteLength) return { body: {} };
  const ctype = String(request.headers.get("content-type") || "").toLowerCase();
  if (ctype && ctype.indexOf("application/json") === -1) return { error: "bad_request" };
  try {
    const body = JSON.parse(new TextDecoder().decode(buf));
    if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "bad_request" };
    return { body: body };
  } catch (e) {
    return { error: "bad_request" };
  }
}

async function findUser(db, provider, sub) {
  return db.prepare(
    "SELECT id, provider, sub, email, name, created_at, last_login_at FROM users WHERE provider = ? AND sub = ?"
  ).bind(provider, sub).first();
}

async function upsertUser(db, provider, identity, now) {
  const existing = await findUser(db, provider, identity.sub);
  if (!existing) {
    const id = crypto.randomUUID();
    try {
      await db.prepare(
        "INSERT INTO users (id, provider, sub, email, name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        id,
        provider,
        identity.sub,
        identity.email || null,
        identity.name || null,
        now,
        now
      ).run();
    } catch (e) {
      const again = await findUser(db, provider, identity.sub);
      if (!again) throw e;
      return again;
    }
    return findUser(db, provider, identity.sub);
  }
  const email = identity.email || existing.email || null;
  let name = existing.name || null;
  if (identity.name && (provider === "google" || !existing.name)) name = identity.name;
  await db.prepare(
    "UPDATE users SET email = ?, name = ?, last_login_at = ? WHERE id = ?"
  ).bind(email, name, now, existing.id).run();
  return findUser(db, provider, identity.sub);
}

async function requireUser(request, env, origin, now, op) {
  const secret = sessionSecret(env);
  if (!secret) return { error: fail("not_configured", 503, origin, { op: op }) };
  if (!dbReady(env)) return { error: fail("db_unconfigured", 503, origin, { op: op }) };
  const token = bearerToken(request);
  if (!token) return { error: fail("unauthorized", 401, origin, { op: op }) };
  const session = await readSession(secret, token, now);
  if (!session) return { error: fail("unauthorized", 401, origin, { op: op }) };
  const row = await env.DB.prepare(
    "SELECT user_id, expires_at, revoked_at FROM sessions WHERE jti = ?"
  ).bind(session.jti).first();
  if (!row || row.revoked_at || Number(row.expires_at) <= now || row.user_id !== session.userId) {
    return { error: fail("unauthorized", 401, origin, { op: op }) };
  }
  const user = await env.DB.prepare(
    "SELECT id, provider, sub, email, name, created_at, last_login_at FROM users WHERE id = ?"
  ).bind(session.userId).first();
  if (!user) return { error: fail("unauthorized", 401, origin, { op: op }) };
  return { user: user, session: session };
}

function health(env, origin) {
  return json({
    ok: true,
    service: "checker-auth-watchlist",
    enabled: killSwitchEnabled(env && env.AUTH_ENABLED),
    googleClientId: publicClientId(env && env.GOOGLE_CLIENT_ID),
    providers: ["google"],
    maxItems: watchlistMax(env),
    sessionTtlSeconds: sessionTtl(env),
    db: dbReady(env),
  }, 200, origin);
}

async function login(request, env, origin, now, fetchImpl) {
  const parsed = await readJson(request);
  if (parsed.error) return fail(parsed.error, 400, origin, { op: "login" });
  // TODO: Sign in with Apple when a paid Apple Developer account exists.
  if (parsed.body.provider === "apple") {
    return fail("apple_disabled", 400, origin, { op: "login", provider: "apple" });
  }
  if (parsed.body.provider !== "google") return fail("bad_request", 400, origin, { op: "login" });
  if (!dbReady(env)) return fail("db_unconfigured", 503, origin, { op: "login" });
  const secret = sessionSecret(env);
  if (!secret) return fail("not_configured", 503, origin, { op: "login" });
  const provider = "google";
  const idToken = typeof parsed.body.idToken === "string" ? parsed.body.idToken : "";
  const identity = await verifyGoogleIdToken(idToken, env.GOOGLE_CLIENT_ID, fetchImpl, now);
  if (!identity.ok) {
    const status = identity.error === "not_configured" ? 503 : (identity.error === "upstream" ? 502 : 401);
    return fail(identity.error, status, origin, { op: "login", provider: provider });
  }
  let user;
  try {
    user = await upsertUser(env.DB, provider, identity, now);
  } catch (e) {
    return fail("upstream", 503, origin, { op: "login", provider: provider });
  }
  if (!user) return fail("upstream", 503, origin, { op: "login", provider: provider });
  const jti = crypto.randomUUID();
  const ttl = sessionTtl(env);
  let issued;
  try {
    issued = await issueSession(secret, user.id, jti, now, ttl);
    await env.DB.prepare(
      "INSERT INTO sessions (jti, user_id, expires_at, revoked_at) VALUES (?, ?, ?, NULL)"
    ).bind(jti, user.id, issued.exp).run();
    await env.DB.prepare(
      "DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?"
    ).bind(user.id, now).run();
  } catch (e) {
    return fail("upstream", 503, origin, { op: "login", provider: provider });
  }
  audit({ ok: true, op: "login", provider: provider });
  return json({
    ok: true,
    token: issued.token,
    tokenType: "Bearer",
    expiresAt: isoSeconds(issued.exp),
    user: userView(user),
  }, 200, origin);
}

async function logout(request, env, origin, now) {
  const auth = await requireUser(request, env, origin, now, "logout");
  if (auth.error) return auth.error;
  await env.DB.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL"
  ).bind(now, auth.session.jti).run();
  audit({ ok: true, op: "logout", provider: auth.user.provider });
  return json({ ok: true }, 200, origin);
}

async function whoami(request, env, origin, now) {
  const auth = await requireUser(request, env, origin, now, "session");
  if (auth.error) return auth.error;
  return json({ ok: true, user: userView(auth.user) }, 200, origin);
}

async function listWatch(request, env, origin, now) {
  const auth = await requireUser(request, env, origin, now, "list");
  if (auth.error) return auth.error;
  const rows = await env.DB.prepare(
    "SELECT product_code, created_at FROM watchlist WHERE user_id = ? ORDER BY created_at DESC, product_code ASC"
  ).bind(auth.user.id).all();
  const list = rows && rows.results ? rows.results : [];
  return json({
    ok: true,
    max: watchlistMax(env),
    codes: list.map(function (row) {
      return { code: row.product_code, createdAt: isoSeconds(row.created_at) };
    }),
  }, 200, origin);
}

async function addWatch(request, env, origin, now) {
  const auth = await requireUser(request, env, origin, now, "add");
  if (auth.error) return auth.error;
  const parsed = await readJson(request);
  if (parsed.error) return fail(parsed.error, 400, origin, { op: "add" });
  const code = normalizeProductCode(parsed.body.code);
  if (!code) return fail("bad_code", 400, origin, { op: "add" });
  const max = watchlistMax(env);
  const inserted = await env.DB.prepare(
    "INSERT INTO watchlist (user_id, product_code, created_at) SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM watchlist WHERE user_id = ?1 AND product_code = ?2) AND (SELECT COUNT(*) FROM watchlist WHERE user_id = ?1) < ?4"
  ).bind(auth.user.id, code, now, max).run();
  const changes = inserted && inserted.meta ? Number(inserted.meta.changes) || 0 : 0;
  const row = await env.DB.prepare(
    "SELECT product_code, created_at FROM watchlist WHERE user_id = ? AND product_code = ?"
  ).bind(auth.user.id, code).first();
  if (!row) {
    audit({ ok: false, op: "add", error: "limit" });
    return json({
      ok: false,
      error: "limit",
      message: "追蹤上限係 " + max + " 件。",
      max: max,
    }, 409, origin);
  }
  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?"
  ).bind(auth.user.id).first();
  audit({ ok: true, op: "add" });
  return json({
    ok: true,
    added: changes > 0,
    code: row.product_code,
    createdAt: isoSeconds(row.created_at),
    count: countRow ? Number(countRow.n) || 0 : 0,
    max: max,
  }, changes > 0 ? 201 : 200, origin);
}

async function removeWatch(request, env, origin, now) {
  const auth = await requireUser(request, env, origin, now, "remove");
  if (auth.error) return auth.error;
  const url = new URL(request.url);
  let raw = url.searchParams.get("code") || "";
  if (!raw) {
    const parsed = await readJson(request);
    if (parsed.error) return fail(parsed.error, 400, origin, { op: "remove" });
    raw = parsed.body.code;
  }
  const code = normalizeProductCode(raw);
  if (!code) return fail("bad_code", 400, origin, { op: "remove" });
  const deleted = await env.DB.prepare(
    "DELETE FROM watchlist WHERE user_id = ? AND product_code = ?"
  ).bind(auth.user.id, code).run();
  const changes = deleted && deleted.meta ? Number(deleted.meta.changes) || 0 : 0;
  audit({ ok: true, op: "remove" });
  return json({ ok: true, removed: changes > 0, code: code }, 200, origin);
}

function routePath(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  return path || "/";
}

export async function handleRequest(request, env, deps) {
  const fetchImpl = (deps && deps.fetch) || fetch;
  const nowDate = (deps && deps.now) || new Date();
  const now = Math.floor(nowDate.getTime() / 1000);
  const originHeader = request.headers.get("origin") || "";
  const originCheck = originAllowed(originHeader);
  const corsOrigin = originHeader && originCheck.ok ? originHeader : "";

  if (request.method === "OPTIONS") {
    if (originHeader && !originCheck.ok) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
  }

  if (originHeader && !originCheck.ok) return fail("origin", 403, "");

  const path = routePath(request);
  const enabled = killSwitchEnabled(env && env.AUTH_ENABLED);

  if (request.method === "GET" && path === "/") return health(env || {}, corsOrigin);

  if (!enabled) return fail("auth_disabled", 403, corsOrigin, { op: path });

  try {
    if (request.method === "POST" && path === "/session") {
      return await login(request, env || {}, corsOrigin, now, fetchImpl);
    }
    if (request.method === "GET" && path === "/session") {
      return await whoami(request, env || {}, corsOrigin, now);
    }
    if (request.method === "POST" && path === "/logout") {
      return await logout(request, env || {}, corsOrigin, now);
    }
    if (request.method === "GET" && path === "/watchlist") {
      return await listWatch(request, env || {}, corsOrigin, now);
    }
    if (request.method === "POST" && path === "/watchlist") {
      return await addWatch(request, env || {}, corsOrigin, now);
    }
    if (request.method === "DELETE" && path === "/watchlist") {
      return await removeWatch(request, env || {}, corsOrigin, now);
    }
  } catch (e) {
    return fail("upstream", 503, corsOrigin, { op: path });
  }

  if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
    return fail("method", 405, corsOrigin, { op: path });
  }
  return fail("not_found", 404, corsOrigin, { op: path });
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
