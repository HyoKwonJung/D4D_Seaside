/**
 * foundry-oauth.js — Foundry OAuth2 (Authorization Code + rotating refresh token) 토큰 매니저.
 *
 * ⚠️ Foundry(Multipass) refresh token 은 "회전"한다: refresh 로 access token 을 받을 때마다
 *    새 refresh token 이 발급되고 이전 것은 무효화된다. 따라서 매 갱신 응답의 새 refresh token 을
 *    파일 캐시(.foundry-token-cache.json)에 저장하고 다음 갱신에 사용한다.
 *
 *    우선순위: 캐시 파일의 refresh token > .env 의 FOUNDRY_REFRESH_TOKEN(최초 seed).
 *    → .env 는 최초 1회 seed 로만 쓰이고, 이후엔 캐시가 살아있는 토큰을 관리한다(재시작에도 유지).
 *
 * OSDK createClient 의 토큰 프로바이더로 getAccessToken 을 사용. 순수 fetch (OSDK 의존 없음).
 */

const fs = require("fs");
const path = require("path");

const FOUNDRY_URL = (process.env.FOUNDRY_URL || "").replace(/\/+$/, "");
const CLIENT_ID = process.env.FOUNDRY_CLIENT_ID || "";
const CLIENT_SECRET = process.env.FOUNDRY_CLIENT_SECRET || "";
const ENV_REFRESH_TOKEN = process.env.FOUNDRY_REFRESH_TOKEN || "";
// refresh token 을 받으려면 offline_access 스코프 필요. 실제 스코프는 앱 설정에 맞춰 조정.
const SCOPES = process.env.FOUNDRY_SCOPES || "api:ontologies-read offline_access";

const AUTHORIZE_PATH = "/multipass/api/oauth2/authorize";
const TOKEN_PATH = "/multipass/api/oauth2/token";
const TOKEN_CACHE_PATH = path.join(__dirname, "..", ".foundry-token-cache.json");

let cachedAccessToken = null;
let cachedExpiry = 0;
let currentRefreshToken = ENV_REFRESH_TOKEN;

// 모듈 로드 시 캐시 파일이 있으면 그 refresh token 을 우선 사용
(function loadRefreshCache() {
  try {
    if (fs.existsSync(TOKEN_CACHE_PATH)) {
      const cache = JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, "utf8"));
      if (cache && cache.refresh_token) currentRefreshToken = cache.refresh_token;
    }
  } catch (error) {
    console.warn("[foundry-oauth] token cache read failed:", error.message);
  }
})();

function isConfigured() {
  return Boolean(FOUNDRY_URL && CLIENT_ID && CLIENT_SECRET);
}

function hasRefreshToken() {
  return Boolean(currentRefreshToken);
}

function saveRefreshCache() {
  try {
    fs.writeFileSync(
      TOKEN_CACHE_PATH,
      JSON.stringify({ refresh_token: currentRefreshToken, updated_at: new Date().toISOString() }, null, 2)
    );
  } catch (error) {
    console.warn("[foundry-oauth] token cache write failed:", error.message);
  }
}

// 회전된 refresh token 을 반영·영속화
function adoptRefreshToken(newToken) {
  if (newToken && newToken !== currentRefreshToken) {
    currentRefreshToken = newToken;
    saveRefreshCache();
  }
}

function buildAuthorizeUrl(redirectUri, state) {
  if (!isConfigured()) throw new Error("Foundry OAuth not configured (FOUNDRY_URL/CLIENT_ID/CLIENT_SECRET).");
  const url = new URL(FOUNDRY_URL + AUTHORIZE_PATH);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest(params) {
  const response = await fetch(FOUNDRY_URL + TOKEN_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams(params).toString()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Foundry token error ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function exchangeCodeForTokens(code, redirectUri) {
  const data = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  });
  // 최초 refresh token 을 즉시 캐시에 저장 → 이후 서버가 이어받아 회전 관리
  adoptRefreshToken(data.refresh_token);
  if (data.access_token) {
    cachedAccessToken = data.access_token;
    cachedExpiry = Date.now() + Math.max(0, Number(data.expires_in || 3600) - 60) * 1000;
  }
  return data;
}

async function refreshAccessToken() {
  if (!hasRefreshToken()) {
    throw new Error("No Foundry refresh token. Run the one-time login (npm run foundry:login) first.");
  }
  const data = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: currentRefreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  });
  // 회전된 새 refresh token 반영·영속화 (핵심)
  adoptRefreshToken(data.refresh_token);
  cachedAccessToken = data.access_token || null;
  cachedExpiry = Date.now() + Math.max(0, Number(data.expires_in || 3600) - 60) * 1000; // 60s 여유
  if (!cachedAccessToken) throw new Error("Foundry token response missing access_token.");
  return cachedAccessToken;
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedExpiry) return cachedAccessToken;
  return refreshAccessToken();
}

module.exports = {
  isConfigured,
  hasRefreshToken,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getAccessToken,
  SCOPES
};
