/**
 * foundry-login.js — 1회성 Authorization Code 로그인 → refresh token 발급.
 *
 * 실행: npm run foundry:login   (또는 node scripts/foundry-login.js)
 *
 * 로컬 콜백 서버를 띄운다. Foundry OAuth 앱의 "허용 redirect URL" 에
 *   http://localhost:5599/api/auth/foundry/callback
 * 를 추가해야 로컬 로그인이 동작한다. (배포본으로 하려면 server.js 의
 *  /api/auth/foundry/login 라우트를 vercel 도메인으로 열어도 됨.)
 *
 * 출력된 refresh token 을 .env 의 FOUNDRY_REFRESH_TOKEN 에 붙여넣으면 끝.
 * 값은 사용자가 관리 — 이 스크립트는 토큰을 파일에 저장하지 않고 터미널에만 1회 출력.
 */

require("dotenv").config();
const http = require("http");
const crypto = require("crypto");
const oauth = require("../lib/foundry-oauth.js");

const PORT = Number(process.env.FOUNDRY_LOGIN_PORT || 5599);
const REDIRECT_URI = process.env.FOUNDRY_LOGIN_REDIRECT
  || `http://localhost:${PORT}/api/auth/foundry/callback`;

if (!oauth.isConfigured()) {
  console.error("먼저 .env 에 FOUNDRY_URL, FOUNDRY_CLIENT_ID, FOUNDRY_CLIENT_SECRET 를 설정하세요.");
  process.exit(1);
}

const state = crypto.randomUUID();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/api/auth/foundry/callback") {
    res.writeHead(404);
    res.end();
    return;
  }
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (!code || returnedState !== state) {
    res.writeHead(400);
    res.end("Invalid code or state.");
    return;
  }
  try {
    const tokens = await oauth.exchangeCodeForTokens(code, REDIRECT_URI);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("로그인 성공. 터미널에 출력된 refresh token 을 복사해 .env 에 저장하세요. 이 탭은 닫아도 됩니다.");
    console.log("\n=== 로그인 완료 ===");
    console.log("refresh token 을 .foundry-token-cache.json 에 자동 저장했습니다 (회전 관리됨).");
    console.log(".env 수동 복사는 불필요합니다. (원하면 백업용으로 아래 값을 FOUNDRY_REFRESH_TOKEN 에 넣어도 됨)\n");
    console.log(tokens.refresh_token || "(refresh_token 없음 — 앱에 offline_access 스코프가 부여됐는지 확인)");
    console.log("\n=================\n");
  } catch (error) {
    res.writeHead(500);
    res.end("토큰 교환 실패: " + error.message);
    console.error(error.message);
  } finally {
    setTimeout(() => server.close(() => process.exit(0)), 500);
  }
});

server.listen(PORT, () => {
  const authUrl = oauth.buildAuthorizeUrl(REDIRECT_URI, state);
  console.log("\n1) Foundry OAuth 앱의 허용 redirect 에 다음이 있는지 확인:");
  console.log("   " + REDIRECT_URI);
  console.log("\n2) 아래 URL 을 브라우저에서 열어 로그인:\n");
  console.log("   " + authUrl + "\n");
});
