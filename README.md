# Digital Enviro

Forum, creator, classes, communities, stores, chat and payments platform. Node 18+ / Express / SQLite / Socket.IO, vanilla JS front end (PWA, installable on phones and desktop).

## Run
```
npm install
cp .env.example .env     # set SITE_URL, ADMIN_* values
npm start
```
Open `SITE_URL`, sign in with the ADMIN account, then go to `/admin` (control dashboard).
Data lives in `data/` (database, backups) and `uploads/`. Back both up. Serve behind HTTPS (Nginx/Caddy, Render, Railway, a VPS).

## Set up in the dashboard (`/admin`)
- **Payment providers**: paste keys per provider and add the webhook URL shown for each one in the provider's dashboard.
  - Paystack, Flutterwave, Stripe: key + webhook.
  - PayPal: REST app Client ID/Secret, webhook (paste its Webhook ID). Enable PayPal Payouts on your business account for automatic PayPal payouts.
  - Tap Payments (KNET, Kuwaiti dinar KWD): secret key + webhook.
  - Wise Business: API token + profile ID. Used for automatic IBAN payouts (Kuwaiti banks, KWD) from your Wise balance.
  - BTCPay Server / NOWPayments: crypto checkout. BTCPay payouts need an automated payout processor.
  - Payoneer has no public API: add it under *My receiving accounts* as a manual receiving account.
- **Dropshipping**: Printful, Printify, CJ keys. Sellers choose one platform or "all". Fee to you is charged every N sales.
- **AI tutor**: add any provider; until then users see "coming soon".
- **Admin team**: give each admin only the permissions you tick. Pay them from the same page.
- Turn email (SMTP), SMS, Google sign-in and push on in *All settings*.

## Honest limits
- Nothing here was run against live provider accounts. Test each provider in sandbox/test mode first, with small amounts.
- Automatic payouts: PayPal, Paystack/Flutterwave (Nigeria and supported countries), BTCPay (BTC), Wise (IBAN, incl. KWD). Other methods stay manual (you mark them paid).
- You fund dropship production with your own platform accounts; customers' payments should cover it. Taxes/VAT are not handled.
- Card subscriptions ended by a class policy are cleared here; cancel recurring billing on the provider side if it keeps charging.
- No system is absolutely secure: keep dependencies updated, use strong owner password, HTTPS, regular backups.
