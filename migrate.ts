import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Applique schema.sql une seule fois (sans effet si les tables existent déjà).
const url = process.env.DATABASE_URL;
if (!url) throw new Error("missing env DATABASE_URL");

const pool = new Pool({ connectionString: url });
const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"), "utf8");

try {
  const r = await pool.query(`SELECT to_regclass('public.users') AS t`);
  if (r.rows[0].t) {
    console.log("migrate: schéma déjà présent, rien à faire");
  } else {
    await pool.query("BEGIN");
    await pool.query(sql);
    await pool.query("COMMIT");
    console.log("migrate: schéma appliqué");
  }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}
