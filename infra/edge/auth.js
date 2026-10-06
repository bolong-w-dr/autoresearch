"use strict";
/*
 * CloudFront Lambda@Edge (viewer-request) that gates the autoresearch
 * dashboard behind corporate SSO via Amazon Cognito (SAML/OIDC federation).
 *
 * Responsibilities
 *   - Redirect unauthenticated browsers to the Cognito hosted UI
 *     (authorization code + PKCE) and complete the flow on /auth/callback.
 *   - Verify the ID token cookie (RS256 against the user pool JWKS) on every
 *     request for static assets and /data/*.
 *   - For /api/*: forward the ID token as a Bearer header for the API Gateway
 *     JWT authorizer and stamp the caller's email into the command body as
 *     `issued_by` so the service records who sent each command.
 *   - Answer /api/me and /auth/logout at the edge.
 *
 * No npm dependencies; config.json is bundled next to this file by Terraform.
 */

const crypto = require("crypto");
const https = require("https");
const querystring = require("querystring");
const config = require("./config.json");

const COOKIE_ID = "ar_id";
const COOKIE_PKCE = "ar_pkce";
const COOKIE_STATE = "ar_state";
const ISSUER = `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;

let jwksCache = { keys: null, fetchedAt: 0 };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseCookies(headers) {
  const out = {};
  for (const h of headers.cookie || []) {
    for (const part of h.value.split(";")) {
      const idx = part.indexOf("=");
      if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

function cookie(name, value, maxAge) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, "Path=/", "Secure", "HttpOnly", "SameSite=Lax"];
  if (maxAge !== undefined) attrs.push(`Max-Age=${maxAge}`);
  return attrs.join("; ");
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function httpRequest(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, timeout: 4000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("upstream timeout")));
    if (body) req.write(body);
    req.end();
  });
}

async function getJwks() {
  if (jwksCache.keys && Date.now() - jwksCache.fetchedAt < 3600 * 1000) return jwksCache.keys;
  const res = await httpRequest(`${ISSUER}/.well-known/jwks.json`);
  if (res.status !== 200) throw new Error(`jwks fetch failed: ${res.status}`);
  jwksCache = { keys: JSON.parse(res.body).keys, fetchedAt: Date.now() };
  return jwksCache.keys;
}

async function verifyIdToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;
  const keys = await getJwks();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    jwksCache.fetchedAt = 0; // key rotation: refetch once
    jwk = (await getJwks()).find((k) => k.kid === header.kid);
    if (!jwk) return null;
  }
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64"));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== ISSUER || payload.aud !== config.clientId || payload.token_use !== "id") return null;
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  if (!isAllowed(payload)) return null;
  return payload;
}

function isAllowed(claims) {
  const email = (claims.email || "").toLowerCase();
  if (config.allowedEmailDomains && config.allowedEmailDomains.length) {
    const domain = email.split("@")[1] || "";
    if (!config.allowedEmailDomains.map((d) => d.toLowerCase()).includes(domain)) return false;
  }
  if (config.allowedGroups && config.allowedGroups.length) {
    const groups = [].concat(claims["cognito:groups"] || [], claims["custom:groups"] || []);
    if (!groups.some((g) => config.allowedGroups.includes(g))) return false;
  }
  return true;
}

function response(status, body, headers = {}, contentType = "application/json") {
  const h = { "content-type": [{ key: "Content-Type", value: contentType }], "cache-control": [{ key: "Cache-Control", value: "no-store" }] };
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = Array.isArray(v) ? v.map((value) => ({ key: k, value })) : [{ key: k, value: v }];
  return { status: String(status), statusDescription: "", headers: h, body: typeof body === "string" ? body : JSON.stringify(body) };
}

function redirect(location, setCookies = []) {
  return response(302, "", { Location: location, "Set-Cookie": setCookies }, "text/plain");
}

function safeReturnPath(value) {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function requestHost(request) {
  return request.headers.host[0].value;
}

// ---------------------------------------------------------------------------
// flows
// ---------------------------------------------------------------------------

function startLogin(request) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(12));
  const returnTo = safeReturnPath(request.uri + (request.querystring ? `?${request.querystring}` : ""));
  const params = {
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: `https://${requestHost(request)}/auth/callback`,
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  if (config.identityProvider) params.identity_provider = config.identityProvider; // skip the Cognito chooser page
  return redirect(`https://${config.cognitoDomain}/oauth2/authorize?${querystring.stringify(params)}`, [
    cookie(COOKIE_PKCE, verifier, 600),
    cookie(COOKIE_STATE, `${state}|${returnTo}`, 600),
  ]);
}

async function handleCallback(request, cookies) {
  const qs = querystring.parse(request.querystring || "");
  if (qs.error) return response(400, { error: qs.error, description: qs.error_description || "" });
  const [expectedState, returnTo] = (cookies[COOKIE_STATE] || "|").split("|");
  if (!qs.code || !qs.state || qs.state !== expectedState || !cookies[COOKIE_PKCE]) {
    return response(400, { error: "invalid_state", description: "Login state mismatch; please retry." });
  }
  const body = querystring.stringify({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code: qs.code,
    redirect_uri: `https://${requestHost(request)}/auth/callback`,
    code_verifier: cookies[COOKIE_PKCE],
  });
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (config.clientSecret) headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  const res = await httpRequest(`https://${config.cognitoDomain}/oauth2/token`, { method: "POST", headers, body });
  if (res.status !== 200) return response(401, { error: "token_exchange_failed", status: res.status });
  const tokens = JSON.parse(res.body);
  const claims = await verifyIdToken(tokens.id_token);
  if (!claims) return response(403, { error: "forbidden", description: "Your account is not permitted to access this dashboard." });
  const maxAge = Math.max(60, Math.min(claims.exp - Math.floor(Date.now() / 1000), config.sessionSeconds || 8 * 3600));
  return redirect(safeReturnPath(returnTo), [cookie(COOKIE_ID, tokens.id_token, maxAge), cookie(COOKIE_PKCE, "", 0), cookie(COOKIE_STATE, "", 0)]);
}

function handleLogout(request) {
  const params = querystring.stringify({ client_id: config.clientId, logout_uri: `https://${requestHost(request)}/` });
  return redirect(`https://${config.cognitoDomain}/logout?${params}`, [cookie(COOKIE_ID, "", 0)]);
}

function forwardApi(request, claims) {
  request.headers.authorization = [{ key: "Authorization", value: `Bearer ${parseCookies(request.headers)[COOKIE_ID]}` }];
  request.headers["x-autoresearch-user"] = [{ key: "X-Autoresearch-User", value: claims.email || claims.sub }];
  if (request.body && request.body.data && request.method === "POST") {
    try {
      const decoded = Buffer.from(request.body.data, request.body.encoding === "base64" ? "base64" : "utf8").toString("utf8");
      const payload = JSON.parse(decoded);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        payload.issued_by = claims.email || claims.sub; // trusted identity, overrides anything the client sent
        request.body.action = "replace";
        request.body.encoding = "text";
        request.body.data = JSON.stringify(payload);
      }
    } catch {
      return response(400, { error: "invalid_json" });
    }
  }
  return request;
}

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const uri = request.uri;
  const cookies = parseCookies(request.headers);

  if (uri === "/auth/callback") return handleCallback(request, cookies);
  if (uri === "/auth/logout") return handleLogout(request);

  const claims = await verifyIdToken(cookies[COOKIE_ID]).catch(() => null);
  const isApi = uri.startsWith("/api/");

  if (!claims) {
    if (isApi) return response(401, { error: "unauthenticated" });
    return startLogin(request);
  }
  if (uri === "/api/me") {
    return response(200, { user: claims.email || claims.sub, auth: "cognito-sso", groups: claims["cognito:groups"] || [], exp: claims.exp });
  }
  if (isApi) return forwardApi(request, claims);

  // Static assets and /data/*: authenticated, pass through to S3.
  return request;
};

// Exposed for unit tests only.
exports._internal = {
  parseCookies,
  verifyIdToken,
  forwardApi,
  safeReturnPath,
  setJwks: (keys) => {
    jwksCache = { keys, fetchedAt: Date.now() };
  },
};
