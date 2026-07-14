// services/backupService.js
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const archiver = require("archiver");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = "mmtbackups";

const TABLES = [
  "bookings",
  "expense_ledger",
  "hotels",
  "ticketing",
  "visa",
  "transport",
  "purchase_entries",
  "users",
  "bank_transactions",
  "cash_transactions",
  "customer_payments",
  "purchase_payments",
];

// ==========================
// CREATE FULL BACKUP
// ==========================
async function createFullBackup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tmpDir = path.join(__dirname, `tmp-${stamp}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  for (const table of TABLES) {
    const file = path.join(tmpDir, `${table}.sql`);
    await execPromise(
      `pg_dump "${process.env.SUPABASE_DB_URL}" -t ${table} > "${file}"`
    );
  }

  const zipPath = path.join(__dirname, `backup-${stamp}.zip`);
  await zipFolder(tmpDir, zipPath);

  const zipBuffer = fs.readFileSync(zipPath);
  await supabase.storage.from(BUCKET).upload(
    `backup-${stamp}.zip`,
    zipBuffer,
    { upsert: true }
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.unlinkSync(zipPath);

  return `backup-${stamp}.zip`;
}

// ==========================
// RESTORE FULL
// ==========================
async function restoreFull(zipFile) {
  const tmp = path.join(__dirname, "restore");
  fs.mkdirSync(tmp, { recursive: true });

  const { data } = await supabase.storage.from(BUCKET).download(zipFile);
  const zipPath = path.join(tmp, zipFile);
  fs.writeFileSync(zipPath, Buffer.from(await data.arrayBuffer()));

  await execPromise(`unzip "${zipPath}" -d "${tmp}"`);

  for (const table of TABLES) {
    const sql = path.join(tmp, `${table}.sql`);
    if (fs.existsSync(sql)) {
      await execPromise(`psql "${process.env.SUPABASE_DB_URL}" < "${sql}"`);
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  return true;
}

// ==========================
// RESTORE SINGLE TABLE
// ==========================
async function restoreTable(zipFile, table) {
  const tmp = path.join(__dirname, "restore");
  fs.mkdirSync(tmp, { recursive: true });

  const { data } = await supabase.storage.from(BUCKET).download(zipFile);
  const zipPath = path.join(tmp, zipFile);
  fs.writeFileSync(zipPath, Buffer.from(await data.arrayBuffer()));

  await execPromise(`unzip "${zipPath}" -d "${tmp}"`);

  const sql = path.join(tmp, `${table}.sql`);
  if (!fs.existsSync(sql)) throw new Error("Table not found in backup");

  await execPromise(`psql "${process.env.SUPABASE_DB_URL}" < "${sql}"`);
  fs.rmSync(tmp, { recursive: true, force: true });

  return true;
}

// ==========================
function execPromise(cmd) {
  return new Promise((res, rej) => {
    exec(cmd, (err) => (err ? rej(err) : res()));
  });
}

function zipFolder(src, out) {
  return new Promise((res, rej) => {
    const output = fs.createWriteStream(out);
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.pipe(output);
    archive.directory(src, false);
    archive.finalize();

    output.on("close", res);
    archive.on("error", rej);
  });
}

module.exports = {
  createFullBackup,
  restoreFull,
  restoreTable,
  TABLES,
};


