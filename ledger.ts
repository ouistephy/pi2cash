import type { PoolClient } from "pg";

export type Entry = { account: string; amount: bigint; currency: "PI" | "XOF" };

/** Convention : montant > 0 = débit, < 0 = crédit. Chaque devise doit s'équilibrer à 0. */
export async function post(
  db: PoolClient,
  idempotencyKey: string,
  kind: string,
  entries: Entry[],
): Promise<{ replayed: boolean }> {
  const sums = new Map<string, bigint>();
  for (const e of entries) {
    if (e.amount === 0n) throw new Error("zero entry");
    sums.set(e.currency, (sums.get(e.currency) ?? 0n) + e.amount);
  }
  for (const [cur, s] of sums) if (s !== 0n) throw new Error(`unbalanced ${cur}: ${s}`);

  const tx = await db.query(
    `INSERT INTO ledger_tx(idempotency_key, kind) VALUES ($1,$2)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [idempotencyKey, kind],
  );
  if (tx.rowCount === 0) return { replayed: true };

  for (const e of entries) {
    await db.query(
      `INSERT INTO accounts(code, currency) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [e.account, e.currency],
    );
    await db.query(
      `INSERT INTO ledger_entries(tx_id, account, amount, currency) VALUES ($1,$2,$3,$4)`,
      [tx.rows[0].id, e.account, e.amount.toString(), e.currency],
    );
  }
  return { replayed: false };
}

/** Solde d'un compte passif utilisateur (crédits - débits), en unités minimales. */
export async function userBalance(db: PoolClient, account: string): Promise<bigint> {
  const r = await db.query(
    `SELECT COALESCE(-SUM(amount),0)::text AS bal FROM ledger_entries WHERE account=$1`,
    [account],
  );
  return BigInt(r.rows[0].bal);
}
