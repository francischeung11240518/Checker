import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { clearTokenCache, signServiceAccountJwt, visionAuth } from "../src/auth.js";

test("service-account JWT is RS256 and scoped to Cloud Vision", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sa = {
    client_email: "vision-ocr-test@example.iam.gserviceaccount.com",
    private_key: privateKey,
  };
  const jwt = await signServiceAccountJwt(sa, 1_700_000_000);
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  const verify = createVerify("RSA-SHA256");
  verify.update(parts[0] + "." + parts[1]);
  verify.end();
  const sig = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  assert.equal(verify.verify(publicKey, sig), true);
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  assert.equal(payload.iss, sa.client_email);
  assert.equal(payload.scope, "https://www.googleapis.com/auth/cloud-vision");
  assert.equal(payload.aud, "https://oauth2.googleapis.com/token");
});

test("API key stays in a header and is not fetched", async () => {
  clearTokenCache();
  let called = 0;
  const auth = await visionAuth({ GOOGLE_VISION_API_KEY: "test-key-not-real" }, function () {
    called += 1;
    throw new Error("should not fetch");
  }, 1_700_000_000);
  assert.equal(called, 0);
  assert.equal(auth.headers["x-goog-api-key"], "test-key-not-real");
  assert.equal(auth.headers.authorization, undefined);
});

test("missing secret does not call Google", async () => {
  clearTokenCache();
  let called = 0;
  const auth = await visionAuth({}, function () { called += 1; }, 1_700_000_000);
  assert.equal(auth.error, "not_configured");
  assert.equal(called, 0);
});

test("service account token is cached", async () => {
  clearTokenCache();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let calls = 0;
  const fetchImpl = async function () {
    calls += 1;
    return new Response(JSON.stringify({ access_token: "ya29.test-token", expires_in: 3600 }), { status: 200 });
  };
  const env = {
    GOOGLE_VISION_SERVICE_ACCOUNT: JSON.stringify({
      client_email: "cache-test@example.iam.gserviceaccount.com",
      private_key: privateKey,
    }),
    GOOGLE_VISION_API_KEY: "test-key-not-real",
  };
  const first = await visionAuth(env, fetchImpl, 1_700_000_000);
  const second = await visionAuth(env, fetchImpl, 1_700_000_100);
  assert.equal(first.headers.authorization, "Bearer ya29.test-token");
  assert.equal(second.headers.authorization, "Bearer ya29.test-token");
  assert.equal(calls, 1);
  assert.equal(first.headers["x-goog-api-key"], undefined);
});
