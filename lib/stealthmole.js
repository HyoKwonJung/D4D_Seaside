const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const BASE_URL =
  process.env.STEALTHMOLE_BASE_URL || "https://hackathon.stealthmole.com";

function createAuthHeader() {
  const accessKey = process.env.STEALTHMOLE_ACCESS_KEY;
  const secretKey = process.env.STEALTHMOLE_SECRET_KEY;

  if (!accessKey || !secretKey) {
    throw new Error(
      "Missing STEALTHMOLE_ACCESS_KEY or STEALTHMOLE_SECRET_KEY in .env"
    );
  }

  const payload = {
    access_key: accessKey,
    nonce: crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000),
  };

  const token = jwt.sign(payload, secretKey, { algorithm: "HS256" });
  return `Bearer ${token}`;
}

async function stealthmoleGet(path, params = {}) {
  const url = new URL(path, BASE_URL);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: createAuthHeader(),
      Accept: "application/json",
    },
  });

  const contentType = response.headers.get("content-type") || "";

  let body;
  if (contentType.includes("application/json")) {
    body = await response.json();
  } else {
    body = await response.text();
  }

  if (!response.ok) {
    const error = new Error(
      `StealthMole API error ${response.status}: ${JSON.stringify(body)}`
    );
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function getQuotas() {
  return stealthmoleGet("/user/quotas");
}

function searchTelegramKeyword(query) {
  return stealthmoleGet("/tt/search/keyword/target", {
    targets: "telegram.message,telegram.channel,telegram.user",
    text: query,
    limit: 20,
    wait: false,
    orderType: "createDate",
    order: "desc",
  });
}

function pollTelegramSearch(id, cursor = 0) {
  return stealthmoleGet(`/tt/search/${id}`, {
    limit: 20,
    cursor,
    orderType: "createDate",
    order: "desc",
  });
}

function getTelegramNode(id, pid) {
  return stealthmoleGet("/tt/node", {
    id,
    pid,
    data_from: false,
    include_url: false,
    include_contents: true,
  });
}

function searchMonitoring(query) {
  return Promise.allSettled([
    stealthmoleGet("/rm/search", {
      query,
      limit: 20,
      cursor: 0,
      orderType: "detectionTime",
      order: "desc",
    }),
    stealthmoleGet("/lm/search", {
      query,
      limit: 20,
      cursor: 0,
      orderType: "detectionTime",
      order: "desc",
    }),
    stealthmoleGet("/gm/search", {
      query,
      limit: 20,
      cursor: 0,
      orderType: "detectionTime",
      order: "desc",
    }),
  ]).then(([rm, lm, gm]) => ({
    ransomware:
      rm.status === "fulfilled" ? rm.value : { error: rm.reason.message },
    leakedMonitoring:
      lm.status === "fulfilled" ? lm.value : { error: lm.reason.message },
    governmentMonitoring:
      gm.status === "fulfilled" ? gm.value : { error: gm.reason.message },
  }));
}

module.exports = {
  getQuotas,
  searchTelegramKeyword,
  pollTelegramSearch,
  getTelegramNode,
  searchMonitoring,
};