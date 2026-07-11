# TeamTales

TeamTales is a Node.js application with a React UI and a MySQL database accessed asynchronously through Drizzle ORM and `mysql2/promise`.

## Local development

Create a MySQL database, copy `.env.example` to `.env`, and set either `DATABASE_URL` or the `DB_*` variables. Then run:

```sh
npm install
npm run dev
```

The API runs on port 8787 by default and Vite proxies `/api` to it. Database migrations run automatically when the API starts.

## Production and Wasmer

```sh
npm run build
npm start
```

The production process serves both the built UI and `/api` from `PORT`. `app.yaml` requests Wasmer's MySQL capability. Wasmer supplies `DB_HOST`, `DB_PORT`, `DB_USERNAME` (or `DB_USER`), `DB_PASSWORD`, and `DB_NAME`; `DATABASE_URL` is also supported.

Deploy from the repository root:

```sh
wasmer deploy --build-remote
```

Set `TEAMTALES_CREDENTIAL_KEY` as a deployment secret before storing integration credentials. In production, also set `TEAMTALES_PUBLIC_ORIGIN` and `TEAMTALES_COOKIE_SECURE=true`.

## Checks

```sh
npm run check
```

MySQL integration tests use `TEAMTALES_TEST_DATABASE_URL` and are skipped when it is unset.
