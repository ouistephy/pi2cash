import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import * as pi from "./pi.js";
import * as ledger from "./ledger.js";
import { providers } from "./payouts.js";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const pool = new Pool({ connectionString: env("DATABASE_URL") });
const app = Fastify({ logger: true });
await app.register(jwt, { secret: env("JWT_SECRET") });

// Taux : PLACEHOLDER via env. En production il doit venir de ton connecteur exchange (+ marge de sécurité).
const RATE = BigInt(env("RATE_XOF_PER_PI"));
const FEE_BPS = BigInt(process.env.FEE_BPS ?? "150");
const QUOTE_TTL_S = 120;
const MIN_KYC_FOR_PAYOUT = 1;

async function tx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const out = await fn(db);
    await db.query("COMMIT");
    return out;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}

const auth = async (req: any) => req.jwtVerify();
const uid = (req: any): number => req.user.sub;

// Santé (pour l'hébergeur)
app.get("/health", async () => ({ ok: true }));

// Page de l'application (servie par le même serveur : une seule adresse à déclarer dans Pi)
const here = dirname(fileURLToPath(import.meta.url));
const indexPath = [join(here, "index.html"), join(here, "..", "index.html")].find(existsSync);
app.get("/", async (_req, reply) => {
  if (!indexPath) return reply.code(404).send({ message: "index.html introuvable" });
  reply.type("text/html; charset=utf-8");
  return readFile(indexPath, "utf8");
});

// Clé de validation de domaine demandée par le Pi Developer Portal (optionnelle)
app.get("/validation-key.txt", async (_req, reply) => {
  const k = process.env.PI_VALIDATION_KEY;
  if (!k) return reply.code(404).send({ message: "not set" });
  reply.type("text/plain; charset=utf-8");
  return k;
});

// 1. Auth Pi -------------------------------------------------------
app.post("/auth", async (req) => {
  const { accessToken } = z.object({ accessToken: z.string() }).parse(req.body);
  const u = await pi.verifyUser(accessToken);
  const r = await pool.query(
    `INSERT INTO users(pi_uid, pi_username) VALUES ($1,$2)
     ON CONFLICT (pi_uid) DO UPDATE SET pi_username = EXCLUDED.pi_username RETURNING id`,
    [u.uid, u.username],
  );
  return { token: app.jwt.sign({ sub: r.rows[0].id }, { expiresIn: "1h" }) };
});

// 2. Quote verrouillée ---------------------------------------------
app.post("/quotes", { preHandler: auth }, async (req) => {
  const { pi: amount } = z.object({ pi: z.number().positive().max(100_000) }).parse(req.body);
  const units = pi.toNanoPi(amount);
  const q = pi.computeQuote(units, RATE, FEE_BPS);
  if (q.net <= 0n) throw new Error("amount too small");
  const id = randomUUID();
  const expires = new Date(Date.now() + QUOTE_TTL_S * 1000);
  await pool.query(
    `INSERT INTO quotes(id,user_id,pi_units,rate_xof_per_pi,fee_bps,xof_gross,xof_fee,xof_net,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, uid(req), units.toString(), RATE.toString(), FEE_BPS.toString(),
     q.gross.toString(), q.fee.toString(), q.net.toString(), expires],
  );
  return { quoteId: id, xofNet: q.net.toString(), xofFee: q.fee.toString(), expiresAt: expires };
});

// 3a. Pi onReadyForServerApproval ----------------------------------
app.post("/pi/approve", { preHandler: auth }, async (req) => {
  const { paymentId } = z.object({ paymentId: z.string() }).parse(req.body);
  const p = await pi.getPayment(paymentId);
  const quoteId = p.metadata?.quoteId;
  if (!quoteId) throw new Error("missing quoteId");

  const q = (await pool.query(`SELECT * FROM quotes WHERE id=$1 AND user_id=$2`, [quoteId, uid(req)])).rows[0];
  if (!q) throw new Error("quote not found");
  if (q.used_at || new Date(q.expires_at) < new Date()) throw new Error("quote expired or used");
  if (pi.toNanoPi(p.amount).toString() !== q.pi_units) throw new Error("amount mismatch");

  await pool.query(
    `INSERT INTO pi_payments(pi_payment_id,user_id,quote_id,status) VALUES ($1,$2,$3,'approved')
     ON CONFLICT (pi_payment_id) DO NOTHING`,
    [paymentId, uid(req), quoteId],
  );
  await pi.approvePayment(paymentId);
  return { ok: true };
});

// 3b. Pi onReadyForServerCompletion --------------------------------
app.post("/pi/complete", { preHandler: auth }, async (req) => {
  const { paymentId, txid } = z.object({ paymentId: z.string(), txid: z.string() }).parse(req.body);
  const p = await pi.getPayment(paymentId);
  if (p.status.cancelled) throw new Error("payment cancelled");
  if (!p.transaction?.verified || p.transaction.txid !== txid) throw new Error("tx not verified on chain");

  await tx(async (db) => {
    const row = (await db.query(
      `SELECT pp.status, q.* FROM pi_payments pp JOIN quotes q ON q.id=pp.quote_id
       WHERE pp.pi_payment_id=$1 AND pp.user_id=$2 FOR UPDATE OF pp`, [paymentId, uid(req)])).rows[0];
    if (!row) throw new Error("unknown payment");
    if (row.status === "completed") return; // rejeu : sans effet

    const piU = BigInt(row.pi_units), gross = BigInt(row.xof_gross);
    const fee = BigInt(row.xof_fee), net = BigInt(row.xof_net);
    const uPi = `user:${uid(req)}:pi`, uXof = `user:${uid(req)}:xof`;

    await ledger.post(db, `pi:${paymentId}:receive`, "pi_receive", [
      { account: "platform:pi_treasury", amount: piU, currency: "PI" },
      { account: uPi, amount: -piU, currency: "PI" },
    ]);
    await ledger.post(db, `pi:${paymentId}:convert`, "convert", [
      { account: uPi, amount: piU, currency: "PI" },
      { account: "platform:pi_sold", amount: -piU, currency: "PI" },
      { account: "platform:xof_funding", amount: gross, currency: "XOF" },
      { account: uXof, amount: -net, currency: "XOF" },
      { account: "platform:fees", amount: -fee, currency: "XOF" },
    ]);
    await db.query(`UPDATE pi_payments SET status='completed', txid=$2 WHERE pi_payment_id=$1`, [paymentId, txid]);
    await db.query(`UPDATE quotes SET used_at=now() WHERE id=$1`, [row.id]);
  });

  await pi.completePayment(paymentId, txid);
  return { ok: true };
});

// 4. Solde ---------------------------------------------------------
app.get("/balance", { preHandler: auth }, async (req) => {
  const db = await pool.connect();
  try {
    return { xof: (await ledger.userBalance(db, `user:${uid(req)}:xof`)).toString() };
  } finally {
    db.release();
  }
});

// 5. Payout --------------------------------------------------------
app.post("/payouts", { preHandler: auth }, async (req) => {
  const key = z.string().min(8).parse(req.headers["idempotency-key"]);
  const b = z.object({
    channel: z.string(),
    destination: z.string().min(6),
    amountXof: z.string().regex(/^\d+$/),
  }).parse(req.body);
  const provider = providers.get(b.channel);
  if (!provider) throw new Error("unsupported channel");
  const amount = BigInt(b.amountXof);
  const userId = uid(req);
  const uXof = `user:${userId}:xof`;
  const payoutId = randomUUID();

  const existing = await pool.query(`SELECT id,status FROM payouts WHERE idempotency_key=$1`, [key]);
  if (existing.rowCount) return existing.rows[0];

  // Réserve les fonds atomiquement (verrou par utilisateur => pas de double dépense)
  await tx(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock($1)`, [userId]);
    const kyc = (await db.query(`SELECT kyc_level FROM users WHERE id=$1`, [userId])).rows[0].kyc_level;
    if (kyc < MIN_KYC_FOR_PAYOUT) throw new Error("kyc required");
    if ((await ledger.userBalance(db, uXof)) < amount) throw new Error("insufficient balance");
    await ledger.post(db, `payout:${payoutId}:reserve`, "payout_reserve", [
      { account: uXof, amount, currency: "XOF" },
      { account: "platform:payout_clearing", amount: -amount, currency: "XOF" },
    ]);
    await db.query(
      `INSERT INTO payouts(id,user_id,channel,destination,amount_xof,status,idempotency_key)
       VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
      [payoutId, userId, b.channel, b.destination, amount.toString(), key],
    );
  });

  const res = await provider.send({ payoutId, destination: b.destination, amountXof: amount });

  if (res.status === "sent") {
    await pool.query(`UPDATE payouts SET status='sent', provider_ref=$2 WHERE id=$1`, [payoutId, res.providerRef]);
    return { id: payoutId, status: "sent" };
  }
  // Échec : on restitue les fonds (écriture inverse)
  await tx(async (db) => {
    await ledger.post(db, `payout:${payoutId}:refund`, "payout_refund", [
      { account: "platform:payout_clearing", amount, currency: "XOF" },
      { account: uXof, amount: -amount, currency: "XOF" },
    ]);
    await db.query(`UPDATE payouts SET status='failed' WHERE id=$1`, [payoutId]);
  });
  return { id: payoutId, status: "failed", reason: res.reason };
});

await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
