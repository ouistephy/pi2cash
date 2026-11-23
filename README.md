# pi2cash : backend Pi -> XOF -> payout

## Démarrage
1. `cp .env.example .env` et renseigner les valeurs
2. `psql $DATABASE_URL -f schema.sql`
3. `npm install && npm run dev`

## Flux API
| Étape | Route | Rôle |
|---|---|---|
| 1 | `POST /auth` | Vérifie l'accessToken Pi côté serveur, retourne un JWT |
| 2 | `POST /quotes` | Verrouille taux + frais pendant 120 s |
| 3 | `POST /pi/approve` | Appelé par `onReadyForServerApproval` du Pi SDK |
| 4 | `POST /pi/complete` | Appelé par `onReadyForServerCompletion` : vérifie la tx, écrit le ledger |
| 5 | `GET /balance` | Solde XOF de l'utilisateur |
| 6 | `POST /payouts` | Header `Idempotency-Key` obligatoire : réserve les fonds puis envoie |

## Garanties
- Aucun float : Pi en nano-Pi (BigInt), XOF en entiers.
- Ledger à double entrée : chaque transaction doit s'équilibrer par devise.
- Idempotence : rejeu de `/pi/complete` et de `/payouts` sans doublon.
- Pas de double dépense : verrou advisory par utilisateur lors du payout.

## CE QUI EST MOCKÉ (à remplacer avant toute mise en production)
- `RATE_XOF_PER_PI` : taux fixe, à remplacer par un connecteur exchange avec marge de sécurité.
- `src/payouts.ts` : `MockProvider` n'envoie aucun argent. Implémenter `PayoutProvider` avec un agrégateur agréé (CinetPay, PayDunya, Flutterwave...).
- KYC : `kyc_level` existe mais aucun flux de vérification n'est implémenté.
- Pas de webhook de confirmation payout, ni de réconciliation, ni de tests.

## Légal
La conversion crypto vers XOF et le transfert d'argent sont réglementés (BCEAO). Faire valider le modèle par un juriste local avant lancement.
