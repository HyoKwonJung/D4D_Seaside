const fs = require("fs");
const path = require("path");

const INDEX_PATH = path.join(__dirname, "..", "public", "index.html");

let cachedCables = null;

function loadCableReference(forceRefresh) {
  if (cachedCables && !forceRefresh) return cachedCables;
  const html = fs.readFileSync(INDEX_PATH, "utf8");
  const match = html.match(/const CABLES = (\[[\s\S]*?\]);\s*const CONTOUR = /);
  if (!match) {
    throw new Error("Unable to load cable reference data from public/index.html.");
  }
  cachedCables = JSON.parse(match[1]);
  return cachedCables;
}

module.exports = {
  loadCableReference
};
