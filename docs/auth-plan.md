# TeamTales Authentication Plan

## Security model

TeamTales supports two credential transports:

- Browser requests authenticate with an opaque server-side session in an `HttpOnly` cookie. Browser JavaScript never reads or stores the session token.
- Programmatic API requests authenticate with an opaque bearer token attached to a user. API tokens are shown once when created.

Passwords are hashed with a memory-hard password KDF and unique salts. Session and API token secrets are generated with a cryptographically secure random source. Only SHA-256 token hashes are stored in SQLite; plaintext credentials are never persisted or logged.

Authentication establishes a user principal. Organization authorization is evaluated separately from active membership and role. Request bodies must not select the acting user.

## Browser flow

1. `POST /api/auth/login` verifies email and password and sets `teamtales_session` with `HttpOnly`, `SameSite=Lax`, and `Path=/` attributes.
2. `GET /api/auth/me` reports the authenticated user, or whether first-run bootstrap is available.
3. Cookie-authenticated unsafe requests must pass same-origin CSRF validation.
4. `POST /api/auth/logout` revokes the server-side session before clearing the cookie.
5. Production deployments set the cookie `Secure` flag; local HTTP development leaves it unset.

Existing databases may contain users created before password authentication was added. An administrator can initialize such an account without placing the password in shell history:

```sh
read -s TEAMTALES_PASSWORD && export TEAMTALES_PASSWORD
npm run cli -- auth set-password \
  --db ./teamtales.sqlite --user-id user_id --password-env TEAMTALES_PASSWORD
unset TEAMTALES_PASSWORD
```

## API-token flow

1. An authenticated user creates a named API token.
2. The full token is returned exactly once. The database stores its prefix, hash, owner, timestamps, and optional expiry.
3. Clients send `Authorization: Bearer <token>`.
4. Expired or revoked tokens fail authentication. Token use updates `last_used_at`.
5. Users may list token metadata and revoke their own tokens, but can never retrieve token secrets.

## Authorization rules

- Health, login, and first-run bootstrap are public.
- Bootstrap organization creation is public only while no users exist and must create an owner password.
- All organization data requires an active membership.
- Integration and sync-scope mutations require owner or admin role.
- Sync and report generation require an active membership; destructive or credential-management operations should require owner or admin.
- API errors distinguish unauthenticated (`401`), unauthorized (`403`), invalid input (`400`), and conflicts (`409`).

## Delivery phases

1. Add password credentials, sessions, and API-token persistence plus cryptographic services.
2. Resolve cookie or bearer credentials into an authenticated request principal.
3. Enforce membership and roles on every organization-scoped HTTP route.
4. Add login/logout/bootstrap UI using cookie credentials only.
5. Add expiry, revocation, CSRF, impersonation, cross-tenant, and plaintext-leak tests.
6. Follow up with password reset, email verification, MFA/passkeys, scoped API tokens, session management UI, and audit logging.
