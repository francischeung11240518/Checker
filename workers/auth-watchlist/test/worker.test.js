import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { clearJwksCache, handleRequest } from "../src/index.js";
import { b64urlBytes } from "../src/jwt.js";

const PAGES = "https://francischeung11240518.github.io";
const NOW = new Date("2026-11-05T02:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const GOOGLE_ID = "test-google-client.apps.googleusercontent.com";
const SECRET = "test-session-secret-not-real-0123456789";

const migrationSql = fs.readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(migrationSql);
  return {
    prepare(sql) {
      return {
        bind(...args) {
          const stmt = db.prepare(sql);
          return {
            async first() {
              const row = stmt.get(...args);
              return row || null;
            },
            async all() {
              return { results: stmt.all(...args) };
            },
            async run() {
              const info = stmt.run(...args);
              return { success: true, meta: { changes: info.changes } };
            },
          };
        },
      };
    },
  };
}

function baseEnv(over) {
  return Object.assign({
    AUTH_ENABLED: "true",
    GOOGLE_CLIENT_ID: GOOGLE_ID,
    WATCHLIST_MAX: "50",
    SESSION_TTL_SECONDS: "604800",
    SESSION_SECRET: SECRET,
    DB: memoryDb(),
  }, over || {});
}

function jwksFetch(publicJwk, calls) {
  return async function (url) {
    const u = String(url);
    if (calls) calls.push(u);
    if (u !== "https://www.googleapis.com/oauth2/v3/certs") {
      throw new Error("unexpected " + u);
    }
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function signIdToken(privateKey, payload, kid) {
  const header = { alg: "RS256", typ: "JWT", kid: kid || "test-key" };
  const h = b64urlBytes(new TextEncoder().encode(JSON.stringify(header)));
  const p = b64urlBytes(new TextEncoder().encode(JSON.stringify(payload)));
  const input = h + "." + p;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(input)
  );
  return input + "." + b64urlBytes(new Uint8Array(sig));
}

const keyPair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"]
);
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
publicJwk.kid = "test-key";
publicJwk.alg = "RS256";
publicJwk.use = "sig";

function googleClaims(over) {
  return Object.assign({
    iss: "https://accounts.google.com",
    aud: GOOGLE_ID,
    sub: "google-sub-1",
    exp: NOW_SEC + 3600,
    iat: NOW_SEC,
    email: "ada@example.com",
    email_verified: true,
    name: "Ada Chan",
  }, over || {});
}

function appleClaims(over) {
  return Object.assign({
    iss: "https://appleid.apple.com",
    aud: "com.example.checker.web",
    sub: "apple-sub-1",
    exp: NOW_SEC + 3600,
    iat: NOW_SEC,
    email: "hid@privaterelay.appleid.com",
    email_verified: "true",
  }, over || {});
}

function req(path, opts) {
  const headers = Object.assign({
    origin: PAGES,
  }, (opts && opts.headers) || {});
  return new Request("https://worker.test" + path, {
    method: (opts && opts.method) || "GET",
    headers: headers,
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

async function login(env, provider, claims, extra) {
  const token = await signIdToken(keyPair.privateKey, claims);
  const body = Object.assign({
    provider: provider,
    idToken: token,
  }, extra || {});
  const res = await handleRequest(req("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body,
  }), env, { fetch: jwksFetch(publicJwk), now: NOW });
  const json = await res.json();
  return { res: res, json: json };
}

test("migration creates users, watchlist, and sessions", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(migrationSql);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(function (row) {
    return row.name;
  });
  assert.deepEqual(names.filter(function (name) { return name !== "sqlite_sequence"; }), ["sessions", "users", "watchlist"]);
  assert.match(migrationSql, /Retention period is not decided/);
});

test("auth flag off returns 403 and does not call Google", async () => {
  clearJwksCache();
  const calls = [];
  const env = baseEnv({ AUTH_ENABLED: "false" });
  const session = await handleRequest(req("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { provider: "google", idToken: "nope" },
  }), env, { fetch: jwksFetch(publicJwk, calls), now: NOW });
  const sessionBody = await session.json();
  assert.equal(session.status, 403);
  assert.equal(sessionBody.error, "auth_disabled");
  assert.match(sessionBody.message, /未開放/);
  assert.equal(session.headers.get("access-control-allow-origin"), PAGES);

  const list = await handleRequest(req("/watchlist"), env, { fetch: jwksFetch(publicJwk, calls), now: NOW });
  assert.equal(list.status, 403);
  assert.equal((await list.json()).error, "auth_disabled");

  const add = await handleRequest(req("/watchlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { code: "P000005418" },
  }), env, { fetch: jwksFetch(publicJwk, calls), now: NOW });
  assert.equal(add.status, 403);
  assert.equal(calls.length, 0);

  const health = await handleRequest(req("/"), env, { now: NOW });
  const healthBody = await health.json();
  assert.equal(health.status, 200);
  assert.equal(healthBody.enabled, false);
  assert.equal(healthBody.service, "checker-auth-watchlist");
  assert.equal(JSON.stringify(healthBody).includes(SECRET), false);
  assert.equal(healthBody.googleClientId, GOOGLE_ID);
  assert.deepEqual(healthBody.providers, ["google"]);
  assert.equal(healthBody.appleServicesId, undefined);
});

test("wrangler kill switch is on and does not embed a secret", () => {
  const toml = fs.readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /AUTH_ENABLED = "true"/);
  assert.match(toml, /database_id = "2ddb2690-d53c-48a7-949d-8118b8fe6762"/);
  assert.match(toml, /GOOGLE_CLIENT_ID = "175392803528-9840t8fvs62gur5sa5p9immqkpkid3k6\.apps\.googleusercontent\.com"/);
  assert.equal(toml.includes('AUTH_ENABLED = "false"'), false);
  assert.equal(toml.includes(SECRET), false);
  assert.equal(toml.includes("BEGIN PRIVATE KEY"), false);
  assert.match(toml, /SESSION_SECRET/);
  assert.equal(toml.includes("stays off"), false);
  assert.equal(toml.includes("must remain"), false);
});

test("CORS allows Pages and localhost and rejects other origins", async () => {
  clearJwksCache();
  const env = baseEnv({ AUTH_ENABLED: "false" });
  const preflight = await handleRequest(new Request("https://worker.test/session", {
    method: "OPTIONS",
    headers: {
      origin: PAGES,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type, authorization",
    },
  }), env, { now: NOW });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), PAGES);
  assert.match(preflight.headers.get("access-control-allow-headers"), /authorization/);
  assert.match(preflight.headers.get("access-control-allow-methods"), /DELETE/);

  const local = await handleRequest(new Request("https://worker.test/watchlist", {
    headers: { origin: "http://localhost:8080" },
  }), env, { now: NOW });
  assert.equal(local.status, 403);
  assert.equal(local.headers.get("access-control-allow-origin"), "http://localhost:8080");

  const evil = await handleRequest(new Request("https://worker.test/watchlist", {
    headers: { origin: "https://evil.example" },
  }), env, { now: NOW });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get("access-control-allow-origin"), null);

  const evilPreflight = await handleRequest(new Request("https://worker.test/session", {
    method: "OPTIONS",
    headers: { origin: "https://evil.example" },
  }), env, { now: NOW });
  assert.equal(evilPreflight.status, 403);
  assert.equal(evilPreflight.headers.get("access-control-allow-origin"), null);
});

test("login, add, list, remove, and a second provider stay separate", async () => {
  clearJwksCache();
  const env = baseEnv();
  const google = await login(env, "google", googleClaims());
  assert.equal(google.res.status, 200);
  assert.equal(google.json.tokenType, "Bearer");
  assert.equal(google.json.user.provider, "google");
  assert.equal(google.json.user.email, "ada@example.com");
  assert.equal(google.json.user.name, "Ada Chan");
  assert.equal(google.json.user.sub, undefined);

  const auth = { authorization: "Bearer " + google.json.token, "content-type": "application/json" };
  const added = await handleRequest(req("/watchlist", {
    method: "POST",
    headers: auth,
    body: { code: " p000000670 " },
  }), env, { now: NOW });
  const addedBody = await added.json();
  assert.equal(added.status, 201);
  assert.equal(addedBody.code, "P000000670");
  assert.equal(addedBody.added, true);
  assert.equal(addedBody.count, 1);

  const again = await handleRequest(req("/watchlist", {
    method: "POST",
    headers: auth,
    body: { code: "P000000670" },
  }), env, { now: NOW });
  const againBody = await again.json();
  assert.equal(again.status, 200);
  assert.equal(againBody.added, false);
  assert.equal(againBody.count, 1);

  const odd = await handleRequest(req("/watchlist", {
    method: "POST",
    headers: auth,
    body: { code: "P00001864" },
  }), env, { now: NOW });
  assert.equal((await odd.json()).code, "P00001864");

  const bad = await handleRequest(req("/watchlist", {
    method: "POST",
    headers: auth,
    body: { code: "P000005418;drop" },
  }), env, { now: NOW });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "bad_code");

  const list = await handleRequest(req("/watchlist", { headers: auth }), env, { now: NOW });
  const listBody = await list.json();
  assert.equal(list.status, 200);
  assert.deepEqual(listBody.codes.map(function (row) { return row.code; }).sort(), ["P000000670", "P00001864"]);

  const removed = await handleRequest(req("/watchlist", {
    method: "DELETE",
    headers: auth,
    body: { code: "P000000670" },
  }), env, { now: NOW });
  assert.equal((await removed.json()).removed, true);
  const after = await handleRequest(req("/watchlist", { headers: auth }), env, { now: NOW });
  assert.deepEqual((await after.json()).codes.map(function (row) { return row.code; }), ["P00001864"]);

  const bye = await handleRequest(req("/logout", {
    method: "POST",
    headers: { authorization: "Bearer " + google.json.token },
  }), env, { now: NOW });
  assert.equal(bye.status, 200);
  const stale = await handleRequest(req("/watchlist", { headers: auth }), env, { now: NOW });
  assert.equal(stale.status, 401);
  assert.equal((await stale.json()).error, "unauthorized");
});

test("watchlist stops at 50 items", async () => {
  clearJwksCache();
  const env = baseEnv();
  const google = await login(env, "google", googleClaims({ sub: "cap-user" }));
  const headers = { authorization: "Bearer " + google.json.token, "content-type": "application/json" };
  for (let i = 1; i <= 50; i++) {
    const code = "P" + String(i).padStart(9, "0");
    const res = await handleRequest(req("/watchlist", {
      method: "POST",
      headers: headers,
      body: { code: code },
    }), env, { now: NOW });
    assert.equal(res.status, 201, code);
  }
  const blocked = await handleRequest(req("/watchlist", {
    method: "POST",
    headers: headers,
    body: { code: "P000000051" },
  }), env, { now: NOW });
  const blockedBody = await blocked.json();
  assert.equal(blocked.status, 409);
  assert.equal(blockedBody.error, "limit");
  assert.match(blockedBody.message, /50/);

  const keep = await handleRequest(req("/watchlist", {
    method: "POST",
    headers: headers,
    body: { code: "P000000001" },
  }), env, { now: NOW });
  assert.equal(keep.status, 200);
  assert.equal((await keep.json()).count, 50);

  const dropped = await handleRequest(req("/watchlist?code=P000000001", {
    method: "DELETE",
    headers: headers,
  }), env, { now: NOW });
  assert.equal((await dropped.json()).removed, true);
  const freed = await handleRequest(req("/watchlist", {
    method: "POST",
    headers: headers,
    body: { code: "173520" },
  }), env, { now: NOW });
  const freedBody = await freed.json();
  assert.equal(freed.status, 201);
  assert.equal(freedBody.code, "173520");
  assert.equal(freedBody.count, 50);
});

test("apple login is rejected and does not call Apple", async () => {
  clearJwksCache();
  const calls = [];
  const env = baseEnv();
  const res = await handleRequest(req("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { provider: "apple", idToken: "not-verified", name: "蘋果 用家" },
  }), env, { fetch: jwksFetch(publicJwk, calls), now: NOW });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error, "apple_disabled");
  assert.match(body.message, /Google/);
  assert.equal(calls.length, 0);
  const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").bind().first();
  assert.equal(Number(users.n), 0);
});

test("bad and expired Google tokens are rejected", async () => {
  clearJwksCache();
  const env = baseEnv();
  const missing = await handleRequest(req("/watchlist"), env, { now: NOW });
  assert.equal(missing.status, 401);

  const expired = await login(env, "google", googleClaims({ exp: NOW_SEC - 120 }));
  assert.equal(expired.res.status, 401);
  assert.equal(expired.json.error, "bad_token");

  const wrongAud = await login(env, "google", googleClaims({ aud: "other.apps.googleusercontent.com" }));
  assert.equal(wrongAud.res.status, 401);

  const appleOnGoogle = await login(env, "google", appleClaims());
  assert.equal(appleOnGoogle.res.status, 401);

  const otherKey = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  const forged = await signIdToken(otherKey.privateKey, googleClaims({ sub: "forged" }));
  const forgedRes = await handleRequest(req("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { provider: "google", idToken: forged },
  }), env, { fetch: jwksFetch(publicJwk), now: NOW });
  assert.equal(forgedRes.status, 401);
  assert.equal((await forgedRes.json()).error, "bad_token");
});

test("missing session secret or database fails closed when the flag is on", async () => {
  clearJwksCache();
  const noSecret = baseEnv({ SESSION_SECRET: "" });
  const res = await login(noSecret, "google", googleClaims());
  assert.equal(res.res.status, 503);
  assert.equal(res.json.error, "not_configured");

  const noDb = baseEnv();
  delete noDb.DB;
  const dbRes = await handleRequest(req("/watchlist", {
    headers: { authorization: "Bearer anything" },
  }), noDb, { now: NOW });
  assert.equal(dbRes.status, 503);
  assert.equal((await dbRes.json()).error, "db_unconfigured");
});
