# MailMu

## Local development

1. Install a Node.js version supported by Vercel and PostgreSQL.
2. Copy `.env.example` to `.env` and set the database, session, and SMTP values.
3. Apply database migrations with `npm run db:migrate`.
4. Start the server with `npm start` and open `http://localhost:3000`.
5. Run checks with `npm test`.

## Deploying to Vercel

The root `index.js` exports the Express application for Vercel Functions. Static pages and assets live in `public/`; the admin page remains behind the server-side role check.

1. Create a managed PostgreSQL database for production. Use its pooled connection URL if the provider offers one.
2. Import this repository into Vercel with the project root set to the repository root. Keep the default install and build settings.
3. Add these environment variables to the Vercel Production environment:
   - `NODE_ENV=production`
   - `DATABASE_URL` and `DATABASE_SSL=true`
   - `SESSION_SECRET` with at least 32 random characters
   - `PUBLIC_BASE_URL` set to the deployed HTTPS origin
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`
4. Apply migrations once to the production database with `npm run db:migrate`, using the production database environment variables. Do not run migrations as part of each request.
5. Deploy, then test registration, email verification, password reset, referral progress, balance, and withdrawals before sharing the production URL.

Use separate databases and email credentials for Preview and Production. Never commit `.env` or paste secret values into source files. Login rate limits currently use in-memory storage, so configure a shared rate-limit store before relying on them across multiple serverless instances.
