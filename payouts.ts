export type PayoutRequest = {
  payoutId: string;          // sert aussi de clé d'idempotence chez le provider
  destination: string;       // numéro mobile money ou IBAN
  amountXof: bigint;
};

export type PayoutResult =
  | { status: "sent"; providerRef: string }
  | { status: "failed"; reason: string };

/** Un canal = une implémentation. Ajouter Wave, Orange Money, etc. = ajouter une classe ici. */
export interface PayoutProvider {
  readonly channel: string;
  send(req: PayoutRequest): Promise<PayoutResult>;
}

/** MOCK : n'envoie aucun argent. À remplacer par les vrais connecteurs (agrégateur agréé). */
export class MockProvider implements PayoutProvider {
  constructor(readonly channel: string) {}
  async send(req: PayoutRequest): Promise<PayoutResult> {
    return { status: "sent", providerRef: `mock-${this.channel}-${req.payoutId}` };
  }
}

export const providers = new Map<string, PayoutProvider>(
  ["wave", "orange_money", "mtn_momo", "moov_money", "bank"].map((c) => [c, new MockProvider(c)]),
);
