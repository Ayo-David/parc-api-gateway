# Parc API Gateway

Kong Gateway is Parc's only public ingress. This repository publishes the Mobile and Admin BFF boundaries; it never routes directly to an owning domain service.

## Assumptions

- Kong `3.9.3` runs in DB-less mode from `kong/kong.yml`.
- `/mobile/*` is forwarded to `parc-mobile-bff` with `/mobile` stripped.
- Mobile onboarding therefore enters at `/mobile/v1/onboarding/*`; Auth & Customer remains private and is reached only through the Mobile BFF allowlist.
- `/admin/*` is forwarded to `parc-admin-bff` with `/admin` stripped.
- Production TLS terminates at Caddy on the VPS, which forwards to Kong on loopback. Kong in DB-less mode cannot persist ACME certificates, so it does not terminate public TLS.
- Production networking prevents direct public access to BFFs and all domain services.
- BFFs and domain services independently validate asymmetrically signed JWTs and enforce tenant/audience/session authorization.
- A later security hardening slice will automate Auth JWKS rotation into Kong before enabling its JWT plugin. No signing key is committed here.
- DB-less rate limiting is node-local. A production multi-node deployment must use an external/global enforcement design or accept per-node limits explicitly.

## Local use

Create the shared network once:

```bash
docker network create parc-edge
```

Start the two BFF containers on that network, then run:

```bash
cp .env.example .env
docker compose up -d
curl http://localhost:8091/status
```

The Admin API is bound to `127.0.0.1` and is read-only because Kong is DB-less.

## Validation

```bash
yarn install --frozen-lockfile
yarn validate
docker run --rm -e KONG_DATABASE=off -v "$PWD/kong:/kong/declarative:ro" kong:3.9.3 kong config parse /kong/declarative/kong.yml
docker compose config
```

## Production (single VPS)

```
Internet ──443──▶ Caddy (TLS) ──▶ Kong 127.0.0.1:8090 ──▶ Mobile BFF 127.0.0.1:3010
                                       │                └─▶ Admin BFF  127.0.0.1:3020
                                       ├─ Admin API  127.0.0.1:8091 (read-only, never public)
                                       └─ Status API 127.0.0.1:8100 (/status, /metrics)
```

Every Parc container runs with `--network host`. Kong reaches the BFFs through the same hostnames used locally (`parc-mobile-bff`, `parc-admin-bff`), which the deploy maps to `127.0.0.1` with `--add-host`, so one `kong/kong.yml` serves both environments.

### Deploy and rollback

- `CI` validates every pull request and push.
- `Deploy` runs after `CI` succeeds on `main` (or manually). It sends `kong/kong.yml` and `deploy/apply-config.sh` over SSH. The script parses the configuration with Kong, keeps the running one as the rollback target, replaces the container, waits for `/status`, and restores the last known-good configuration if Kong does not come up. It warns, without failing, when a BFF is unreachable through Kong.
- `Rollback` re-applies the previous configuration, or the configuration at a given commit.

Kong holds no secrets, so there is no server `.env`. State lives in `/opt/parc/parc-api-gateway/`: `config/kong.yml`, `kong.previous.yml`, and `current_revision.txt` / `previous_revision.txt`.

### One-time setup

1. GitHub: add `SERVER_HOST`, `SERVER_PORT`, `SERVER_USER`, `SSH_PRIVATE_KEY` and a `production` environment, as for the backend services.
2. Server: `/opt/parc` must exist and be owned by the deploy user (see `parc-platform/deployment/README.md`).
3. DNS: point the API hostname's A record at the VPS.
4. Caddy: install it, copy `deploy/Caddyfile.example` to `/etc/caddy/Caddyfile` with the real hostname, and `sudo systemctl reload caddy`. Caddy discards client-supplied `X-Forwarded-For`, and Kong trusts only loopback, so rate limiting keys on the real client address.
5. Firewall: only SSH, 80 and 443 may be reachable. Host networking means every service port is otherwise public.

   ```sh
   sudo ufw default deny incoming
   sudo ufw allow <ssh-port>/tcp
   sudo ufw allow 80,443/tcp
   sudo ufw enable
   ```

Deploy the gateway after both BFFs. Then check:

```sh
curl https://<api-host>/mobile/health/live
curl https://<api-host>/admin/health/live
curl -m 3 http://<vps-ip>:3010/health/live   # must time out
```

Do not place JWT private keys, TLS private keys, or provider credentials in `.env`.
