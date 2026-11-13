# GWIC backend

## Paystack wallet setup

Configure `PAYSTACK_SECRET_KEY` as a secret in the backend environment. Use a Paystack test secret for sandbox testing; use a live secret only when ready to process real money. Never add either key to source control or frontend environment variables.

Set `FRONTEND_URL` to the deployed frontend origin so Paystack can return users to the dashboard after checkout.

For native app deposits, the authenticated mobile client may provide the `gwic://deposit-return` app link or an Expo Go development callback. The backend validates the callback before passing it to Paystack. Keep transaction verification and wallet crediting on the backend; a redirect to the app is not proof of payment.

Configure this webhook URL in the Paystack dashboard:

```text
https://gwic-backend.onrender.com/api/paystack/webhook
```

The endpoint verifies Paystack's HMAC signature and handles `charge.success`, `transfer.success`, `transfer.failed`, and `transfer.reversed` events. Keep it publicly reachable over HTTPS.

Deposits are limited to ₦100–₦1,000,000 per transaction. Wallet funds are credited only after the backend verifies a successful Paystack transaction. Withdrawals require at least ₦100, sufficient confirmed wallet funds, and a resolved Nigerian bank account whose holder name matches the user's profile name (case, spaces, and punctuation ignored). Withdrawals are sent from the business Paystack balance; failed or reversed transfers are returned to the wallet.

Paystack can require approval for transfers depending on the account's transfer security settings. In that case, the withdrawal remains reserved and pending until Paystack reports a final transfer event.

The authenticated `GET /api/wallet/transactions?page=1&type=all` endpoint returns wallet activity newest-first in pages of 20. `type` accepts `all`, `deposit`, or `withdrawal`; the response includes `total` and `hasMore` for pagination.

### Concurrent sessions and withdrawals

The backend permits a user to sign in on multiple devices. Each login receives its own signed session cookie; logging out or changing the password increments the user's session version and invalidates all of that user's existing sessions, including sessions on other devices.

Separate withdrawal requests from valid sessions are allowed. Each request must pass the account-password check and have a unique UUID v4 idempotency key. The wallet balance is checked again inside a MongoDB transaction while the withdrawal amount is reserved. Consequently, if two withdrawals race, each can proceed only if the wallet can cover its amount after earlier committed reservations; the pair cannot successfully reserve more than the available wallet balance. If the total requested exceeds the balance, one request should fail for insufficient funds. Paystack may still require approval or later fail/reverse a transfer; those states are asynchronous and must not be presented as completed payouts.

Do not treat this reasoning as a production concurrency test. Validate simultaneous reservations against a dedicated staging MongoDB replica set and Paystack sandbox before relying on behavior under production load.

### Bounded staging read-load test

`node scripts/loadTestWalletReads.js` logs in exactly 70 dedicated staging test accounts sequentially, sends one authenticated `GET /api/wallet` request for each account concurrently, reports status counts and latency percentiles, then logs those test accounts out. It performs no deposits, withdrawals, or other money-changing requests. Do not use customer accounts or production credentials.

Provide a local JSON file outside the repository containing exactly 70 test accounts:

```json
[
  { "email": "load-test-001@example.invalid", "password": "test-only-password" }
]
```

Add the remaining staging-only test accounts before running the script. Set `LOAD_TEST_BASE_URL` to the staging origin, `LOAD_TEST_CONFIRM_HOST` to its exact hostname, `LOAD_TEST_CONFIRMATION` to `I_OWN_THIS_STAGING_SERVICE`, and `LOAD_TEST_USERS_FILE` to the local JSON file path. The script refuses the known production backend hostname, requires HTTPS for non-local targets, and never prints credentials or response bodies. Review staging metrics and service limits before increasing concurrency; this test is a bounded baseline, not a capacity certification.

## Core savings operations

Core Target (12% annual customer yield, 30–60 days) and Core Lock (15%, 90–365 days) are implemented as authenticated investment plans. Amounts are posted in integer kobo and plan creation, wallet debits, and ledger postings use MongoDB transactions. Starting a plan requires a verified user account, sufficient wallet balance, and a UUID v4 idempotency key. `isKycVerified` defaults to `false`; do not set it from a client request. The backend does not collect or store BVNs. Connect a compliant identity-verification provider before enabling customer onboarding.

Core Flex is intentionally unavailable and has no withdrawal endpoint because an instant-access reserve or committed liquidity facility has not been implemented. Early liquidation of locked plans requires password confirmation and returns principal minus the greater of the 3.5% principal penalty or accrued yield; all accrued yield is forfeited. Maturity returns principal and recorded yield to the wallet.

`CORE_SAVINGS_ENABLED` defaults to `false`. Keep it disabled until asset placement/custody, reconciliation, operational funding, legal disclosures, KYC verification, and production controls are ready. The current backend records the yield and spread accruals in its ledger; it does not itself purchase or settle T-Bills, commercial paper, or fund units. Do not enable plans based only on this internal ledger. Before enabling plans, run `npm run wallet:reconcile-opening-balances` once to bring existing wallet balances into the double-entry ledger; review the resulting opening-balance entries with Finance.

The API starts a UTC-midnight scheduler after connecting to MongoDB; it also runs a catch-up sweep at startup and retries failures every five minutes. The sweep is idempotent and catches up missed UTC days. `npm run core-savings:daily` is also available for a dedicated scheduled job or manual operations; do not configure both unless you intend to run a redundant, idempotent sweep. MongoDB must run as a replica set because wallet and investment changes require transactions. Monitor scheduler logs and reconcile ledger balances before enabling customer plans. The endpoint is `GET /api/core-savings`; create plans with `POST /api/core-savings/plans`, and early-liquidate with `POST /api/core-savings/plans/:planId/liquidate`.

## Account settings and support

Signup requires at least a first and last name. Tell users to enter their full legal name as it appears on bank and identity records: bank withdrawals are rejected when the verified bank-account holder name does not match the GWIC profile name. The name is immutable through the regular profile endpoint; users can submit a support request for a correction.

Optional profile photos are uploaded through the authenticated `/api/account/profile/photo` route and stored as authenticated Cloudinary images. Configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` in the backend environment. Only PNG, JPEG, and WebP files under 2 MB are accepted. The API returns a signed image URL; photos are not identity evidence and must not be used for face verification. `DELETE /api/account/profile/photo` removes the current profile photo.

The authenticated `/api/account` routes power the More page:

- `GET/PATCH /profile` reads the account name and updates the phone. The legal account name is fixed after signup; correction requests must go through support. Email changes are not supported by this endpoint.
- `GET/PATCH /preferences` persists wallet-balance visibility and the available display preferences.
- `GET/PATCH /notifications` persists the user's choices, including the notification sound preference. Resend sends account welcome, confirmed deposit, and password-change emails when the matching email preference is enabled. The mobile app plays its selected local sound for newly received inbox notifications while foregrounded; OS push delivery and background sound are not implemented.
- `PATCH /password` verifies the current password, changes it, invalidates prior sessions, and clears the current session cookie.
- `GET/POST /verification` reads or submits a manual verification request. It collects legal name and date of birth, not BVN or identity-document numbers. A request is not proof of verification; a reviewer must validate it separately before account KYC status changes.
- `GET/POST /banks`, `PATCH /banks/:bankId/default`, and `DELETE /banks/:bankId` manage up to three verified payout recipients. Linking requires Paystack configuration, password confirmation, and a holder name matching the GWIC profile. Plain account numbers are not stored; only masked details and a provider recipient reference are retained. A linked account can be selected for wallet withdrawals.
- `GET/POST /support` lists and creates support tickets. Ticket handling is manual; no email delivery or staff dashboard is connected.
- `GET /about` returns the product information shown in More.

For a restricted Resend test, set `RESEND_API_KEY` and `RESEND_TEST_TO` in this backend's ignored `.env` file and run `npm run email:test`. Set `RESEND_TEST_MODE=true` only for local testing: app-triggered welcome, deposit, and security emails will be routed to `RESEND_TEST_TO`, since Resend's test sender only allows the account's verified recipient. This mode is rejected in production. Set it back to `false` after testing. The default `onboarding@resend.dev` sender is not for unrestricted customer delivery; production sending requires a verified domain and `RESEND_FROM_EMAIL` set to an address on that domain. Keep the Resend key only in backend environment settings. Delivery failures are logged and do not reverse a successful account or wallet action.

Configure a long, unique `ACCOUNT_REVIEW_TOKEN` in the backend deployment environment to enable staff operations. The token must only be given to trusted server-side review tooling and must never be exposed in frontend code. With no token configured, review routes return `503`. The protected `/api/account-review/verifications` and `/support` routes list pending items; `PATCH /verifications/:requestId` accepts a `verified` or `rejected` decision, and `PATCH /support/:requestId` updates a ticket status. These APIs are not a staff UI and do not replace a secure evidence-review workflow. Configure and rotate the token outside source control.
