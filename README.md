# TeamTales

TeamTales is a Node.js application with a React UI and a MySQL database accessed asynchronously through Drizzle ORM and `mysql2/promise`.

## Local development

Start the local MySQL container, then launch the API and UI with the matching database connection:

```sh
npm install
npm run db:up
npm run dev
```

The API runs on port 9100 by default and Vite proxies `/api` to it from port 9101. Database migrations run automatically when the API starts.
`npm run dev` starts Vite in its default development mode, which loads `.env.development`. The API is a separate Node process and loads the same file through Node's `--env-file` option; values already present in the environment take precedence. `.env.development` includes `TEAMTALES_CREDENTIAL_KEY` for local development only.
Use the displayed `http://127.0.0.1:9101` URL so authenticated writes match the configured CSRF origin.

Run `npm run db:down` to stop MySQL. Its data is retained in the `mysql-data` Docker volume. The local container uses host networking and binds port 3306, so that port must be available. For a non-Compose database, set `DATABASE_URL` or the `DB_*` variables before running `npm run dev`.

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

Vite+ powers the workspace workflow:

- `npm run dev` starts the API and UI in parallel; the UI gets Vite HMR while
  the API process restarts on server changes.
- `npm run format` and `npm run format:check` apply and verify Oxfmt formatting.
- `npm run lint` runs Oxlint and `npm run typecheck` checks every workspace package.
- `npm run test`, `npm run build`, and `npm run check` run the server tests,
  production build, and the full validation pipeline.

MySQL integration tests use `TEAMTALES_TEST_DATABASE_URL` and are skipped when it is unset.
