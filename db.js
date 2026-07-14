const { Pool } = require("pg");

const connectionString = process.env.SUPABASE_DB_URL;

if (!connectionString) {
  throw new Error("❌ SUPABASE_DB_URL is missing in environment variables");
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 20000,
});

module.exports = pool;
