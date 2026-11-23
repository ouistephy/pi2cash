const API = "https://api.minepi.com/v2";
const PI_UNIT = 10_000_000n; // 1 Pi = 10^7 nano-Pi

export type PiUser = { uid: string; username: string };

/** Vérifie l'accessToken du Pi Browser côté serveur. Ne jamais faire confiance au client. */
export async function verifyUser(accessToken: string): Promise<PiUser> {
  const r = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error("invalid pi access token");
  return (await r.json()) as PiUser;
}

const serverHeaders = () => ({
  Authorization: `Key ${process.env.PI_API_KEY}`,
  "Content-Type": "application/json",
});

export async function getPayment(paymentId: string) {
  const r = await fetch(`${API}/payments/${paymentId}`, { headers: serverHeaders() });
  if (!r.ok) throw new Error(`pi getPayment ${r.status}`);
  return (await r.json()) as {
    identifier: string;
    user_uid: string;
    amount: number;
    metadata: { quoteId?: string };
    transaction?: { txid: string; verified: boolean } | null;
    status: { developer_approved: boolean; transaction_verified: boolean; cancelled: boolean };
  };
}

export async function approvePayment(paymentId: string) {
  const r = await fetch(`${API}/payments/${paymentId}/approve`, { method: "POST", headers: serverHeaders() });
  if (!r.ok) throw new Error(`pi approve ${r.status}`);
}

export async function completePayment(paymentId: string, txid: string) {
  const r = await fetch(`${API}/payments/${paymentId}/complete`, {
    method: "POST",
    headers: serverHeaders(),
    body: JSON.stringify({ txid }),
  });
  if (!r.ok) throw new Error(`pi complete ${r.status}`);
}

/** Convertit le montant décimal renvoyé par Pi en nano-Pi sans passer par un calcul flottant. */
export function toNanoPi(amount: number): bigint {
  const [i, f = ""] = amount.toFixed(7).split(".");
  return BigInt(i) * PI_UNIT + BigInt(f);
}

export type QuoteCalc = { gross: bigint; fee: bigint; net: bigint };

/** gross = pi * taux ; fee = gross * bps / 10000 (arrondi bas) ; net = gross - fee. */
export function computeQuote(piUnits: bigint, rateXofPerPi: bigint, feeBps: bigint): QuoteCalc {
  const gross = (piUnits * rateXofPerPi) / PI_UNIT;
  const fee = (gross * feeBps) / 10_000n;
  return { gross, fee, net: gross - fee };
}
