/**
 * osdk_probe.js — OSDK 연결 및 CableguardEvent 실제 속성명 확인 (1회성).
 * 실행: node foundry/tools/osdk_probe.js
 * .env 의 FOUNDRY_* (refresh token 포함)를 사용해 읽기 전용 조회.
 */
require("dotenv").config();
const osdk = require("../../lib/foundry-osdk.js");

(async () => {
  console.log("isReady:", await osdk.isReady());

  const keys = await osdk.describeFirst();
  console.log("\n=== CableguardEvent 실제 속성 키 ===");
  console.log(keys && keys.length ? keys.join(", ") : "(빈 결과 - 오브젝트가 0개이거나 권한 문제)");

  const events = await osdk.fetchCableGuardEvents({ pageSize: 3 });
  console.log("\n=== mapEvent() 매핑 결과 샘플 (최대 2건) ===");
  console.log(JSON.stringify(events.slice(0, 2), null, 2));
  console.log("\ntotal mapped:", events.length);
})().catch(err => {
  console.error("PROBE ERR:", err.message);
  process.exit(1);
});
