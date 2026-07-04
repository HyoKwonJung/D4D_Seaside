require("dotenv").config();

const db = require("../lib/db.js");

async function main() {
  if (!db.isDatabaseEnabled()) {
    console.log("DATABASE_URL is not set. Skipping migrations.");
    return;
  }

  const ready = await db.initializeDatabase();
  if (!ready) {
    throw new Error("Database initialization failed.");
  }

  console.log("Database migrations applied successfully.");
}

main()
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.closeDatabase();
  });
