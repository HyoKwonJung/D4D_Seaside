/**
 * gfw_probe.js — GFW API 실제 응답 구조 확인용 (1회성).
 *
 * 실행: node foundry/tools/gfw_probe.js
 * .env 의 GFW_API_TOKEN 을 사용한다(코드가 읽음; 콘솔에 토큰은 출력하지 않음).
 * 최근 7일 · 서해 watch area 1곳으로 소량(limit 낮음) 호출해 응답 키만 덤프한다.
 *
 * 목적: lib/gfw.js 와 foundry/transforms/ingestion_adapters.py 의 필드 매핑을
 *       실제 응답에 맞춰 최종 확정하기 위함.
 */

require("dotenv").config();
const gfw = require("../../lib/gfw.js");
const { MARITIME_WATCH_AOIS } = require("../../lib/watch-areas.js");

function keysPreview(obj, depth = 2) {
  if (obj === null || typeof obj !== "object") return typeof obj;
  if (Array.isArray(obj)) return `[${obj.length}] ${obj.length ? keysPreview(obj[0], depth - 1) : ""}`;
  if (depth <= 0) return "{...}";
  const out = {};
  for (const k of Object.keys(obj).slice(0, 25)) out[k] = keysPreview(obj[k], depth - 1);
  return out;
}

async function main() {
  if (!gfw.isEnabled()) {
    console.error("GFW_API_TOKEN not set. Add it to .env first.");
    process.exit(1);
  }

  const westSea = MARITIME_WATCH_AOIS.find(a => a.id === "west-sea") || MARITIME_WATCH_AOIS[0];
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);

  console.log(`Probing GFW for ${westSea.name} | ${startDate} → ${endDate}\n`);

  for (const type of ["loitering", "gap", "encounter"]) {
    try {
      const res = await gfw.getEvents(type, { bounds: westSea.bounds, startDate, endDate, limit: 3 });
      console.log(`--- events:${type} envelope ---`);
      console.log(JSON.stringify(keysPreview(res, 3), null, 2));
      const entries = res.entries || res.events || [];
      if (entries.length) {
        console.log(`--- events:${type} first entry ---`);
        console.log(JSON.stringify(entries[0], null, 2).slice(0, 1500));
      }
    } catch (err) {
      console.warn(`events:${type} -> ${err.message}`);
    }
    console.log("");
  }

  try {
    const sar = await gfw.getSarDetections({ bounds: westSea.bounds, startDate, endDate, matched: false });
    console.log("--- SAR (matched=false) structure ---");
    console.log(JSON.stringify(keysPreview(sar, 4), null, 2));
  } catch (err) {
    console.warn(`sar -> ${err.message}`);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
