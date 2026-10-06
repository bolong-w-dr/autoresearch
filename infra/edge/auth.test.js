"use strict";
// Run with: node --test infra/edge/auth.test.js
// Uses config.example.json (copied to config.json in a temp dir) and a locally
// generated RSA key standing in for the Cognito JWKS.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edge-test-"));
fs.copyFileSync(path.join(__dirname, "auth.js"), path.join(tmp, "auth.js"));
fs.copyFileSync(path.join(__dirname, "config.example.json"), path.join(tmp, "config.json"));
const edge = require(path.join(tmp, "auth.js"));
const config = require(path.join(tmp, "config.json"));

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };
edge._internal.setJwks([jwk]);

const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const issuer = `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;

function makeToken(overrides = {}, kid = "test-kid") {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: issuer, aud: config.clientId, token_use: "id", exp: now + 3600, iat: now, sub: "u-1", email: "alice@example.com", ...overrides };
  const head = b64url(JSON.stringify({ alg: "RS256", kid }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

function event(uri, { cookies = {}, method = "GET", body, querystring = "" } = {}) {
  const headers = { host: [{ key: "Host", value: "research.example.com" }] };
  const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  if (cookieStr) headers.cookie = [{ key: "Cookie", value: cookieStr }];
  const request = { uri, method, querystring, headers };
  if (body !== undefined) request.body = { data: Buffer.from(body).toString("base64"), encoding: "base64", action: "read-only", inputTruncated: false };
  return { Records: [{ cf: { request } }] };
}

test("unauthenticated browser is redirected to Cognito with PKCE", async () => {
  const res = await edge.handler(event("/index.html"));
  assert.equal(res.status, "302");
  const loc = res.headers.location[0].value;
  assert.ok(loc.startsWith(`https://${config.cognitoDomain}/oauth2/authorize?`));
  assert.match(loc, /code_challenge_method=S256/);
  assert.match(loc, /identity_provider=CorporateSSO/);
  assert.match(loc, /redirect_uri=https%3A%2F%2Fresearch.example.com%2Fauth%2Fcallback/);
  const setCookies = res.headers["set-cookie"].map((c) => c.value);
  assert.ok(setCookies.some((c) => c.startsWith("ar_pkce=")));
  assert.ok(setCookies.some((c) => c.startsWith("ar_state=") && c.includes("HttpOnly")));
});

test("unauthenticated API call gets 401 JSON, not a redirect", async () => {
  const res = await edge.handler(event("/api/commands", { method: "POST", body: "{}" }));
  assert.equal(res.status, "401");
  assert.deepEqual(JSON.parse(res.body), { error: "unauthenticated" });
});

test("valid ID token cookie passes static requests through", async () => {
  const res = await edge.handler(event("/data/index.json", { cookies: { ar_id: makeToken() } }));
  assert.equal(res.uri, "/data/index.json");
  assert.equal(res.status, undefined);
});

test("/api/me returns identity from claims", async () => {
  const res = await edge.handler(event("/api/me", { cookies: { ar_id: makeToken({ "cognito:groups": ["ml-platform"] }) } }));
  assert.equal(res.status, "200");
  const body = JSON.parse(res.body);
  assert.equal(body.user, "alice@example.com");
  assert.equal(body.auth, "cognito-sso");
  assert.deepEqual(body.groups, ["ml-platform"]);
});

test("/api/* forwards bearer token and stamps issued_by from the trusted identity", async () => {
  const token = makeToken();
  const body = JSON.stringify({ command: "ping", issued_by: "spoofed@evil.example" });
  const res = await edge.handler(event("/api/commands", { method: "POST", body, cookies: { ar_id: token } }));
  assert.equal(res.headers.authorization[0].value, `Bearer ${token}`);
  assert.equal(res.headers["x-autoresearch-user"][0].value, "alice@example.com");
  assert.equal(res.body.action, "replace");
  assert.deepEqual(JSON.parse(res.body.data), { command: "ping", issued_by: "alice@example.com" });
});

test("rejects expired, wrong-audience, wrong-domain and tampered tokens", async () => {
  const cases = {
    expired: makeToken({ exp: Math.floor(Date.now() / 1000) - 10 }),
    audience: makeToken({ aud: "someone-else" }),
    access_token: makeToken({ token_use: "access" }),
    domain: makeToken({ email: "mallory@evil.example" }),
    unknown_kid: makeToken({}, "other-kid"),
    tampered: makeToken().replace(/\.[^.]+\./, (m) => "." + b64url(JSON.stringify({ iss: issuer, aud: config.clientId, token_use: "id", exp: 9999999999, email: "root@example.com" })) + "."),
  };
  for (const [name, token] of Object.entries(cases)) {
    const res = await edge.handler(event("/", { cookies: { ar_id: token } }));
    assert.equal(res.status, "302", `${name} should redirect to login`);
  }
});

test("callback rejects state mismatch", async () => {
  const res = await edge.handler(event("/auth/callback", { querystring: "code=abc&state=xyz", cookies: { ar_state: "other|/", ar_pkce: "v" } }));
  assert.equal(res.status, "400");
  assert.equal(JSON.parse(res.body).error, "invalid_state");
});

test("logout clears the session cookie and redirects to Cognito", async () => {
  const res = await edge.handler(event("/auth/logout"));
  assert.equal(res.status, "302");
  assert.ok(res.headers.location[0].value.startsWith(`https://${config.cognitoDomain}/logout?`));
  assert.ok(res.headers["set-cookie"][0].value.startsWith("ar_id=; ") && res.headers["set-cookie"][0].value.includes("Max-Age=0"));
});

test("return path is constrained to same-origin relative paths", () => {
  assert.equal(edge._internal.safeReturnPath("/missions/1"), "/missions/1");
  assert.equal(edge._internal.safeReturnPath("//evil.example"), "/");
  assert.equal(edge._internal.safeReturnPath("https://evil.example"), "/");
  assert.equal(edge._internal.safeReturnPath(undefined), "/");
});
