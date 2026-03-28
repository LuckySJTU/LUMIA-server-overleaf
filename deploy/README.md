# Lumia Overleaf Docker deployment

## Files

- `deploy/overleaf.lumia.env.example`: runtime environment template
- `deploy/docker-compose.lumia.yml`: Mongo, Redis, and the Overleaf CE container
- `deploy/build-image.sh`: image build script
- `deploy/deploy.sh`: compose deployment script
- `deploy/texlive-packages.lumia.md`: curated TeX Live package manifest for Lumia
- `deploy/nginx/overleaf-public.conf.example`: host Nginx TLS reverse-proxy example

## Prepare

1. Copy `deploy/overleaf.lumia.env.example` to `deploy/overleaf.lumia.env`.
2. Fill in at least:
   - `OVERLEAF_SITE_URL`
   - `OVERLEAF_SESSION_SECRET`
   - `WEB_API_PASSWORD`
   - `OVERLEAF_LDAP_BIND_CREDENTIALS`
3. Review the LDAP search filter.
   - This setup assumes Lumia LDAP users log in with `uid`, so the default filter is `(uid={{username}})`.
4. Keep `OVERLEAF_LDAP_OVERLEAF_EMAIL_DOMAIN=lumia.cn` unless you want a different local Overleaf email suffix.
5. If you plan to publish the service on the public Internet behind HTTPS, keep:
   - `OVERLEAF_HTTP_BIND_IP=127.0.0.1`
   - `OVERLEAF_SITE_URL=https://your-domain`
   - `OVERLEAF_SECURE_COOKIE=true`
6. Keep `OVERLEAF_MONGO_IMAGE=mongo:8.0`.
   - Current Overleaf startup checks require MongoDB 8.0 or newer.
7. `OVERLEAF_TEXLIVE_SCHEME` controls the base TeX Live scheme installed by `install-tl`.
   - Default is `scheme-medium`.
   - The official TeX Live guide describes `medium` as `small + more packages and languages`, while `small` already includes `basic + xetex, metapost, a few languages`.
   - This is more stable than starting from `scheme-basic` and then asking `tlmgr` to install many large collections in one step.
8. `OVERLEAF_TEXLIVE_EXTRA_PACKAGES` controls extra LaTeX packages installed after the base scheme.
   - Default is `"collection-langcjk microtype tools caption booktabs multirow cleveref mathtools todonotes xcolor hyperref enumitem algorithms algorithmicx natbib url xurl units wrapfig float sttools adjustbox threeparttable tablefootnote soul ulem listings pgf pgfplots siunitx makecell preprint forloop xifthen ifmtarg cmap psnfss textcase changepage datetime fmtcount fancyhdr lastpage titlesec needspace kvoptions tcolorbox fontawesome5 xcharter fontaxes mweights newtx zlmtt extsizes geometry colortbl forest elocalloc changes xstring truncate bclogo mdframed zref lipsum tocloft bbding epigraph nextpage minitoc textgreek cjk greek-fontenc cbfonts cbfonts-fd"`.
   - This keeps Chinese and common typography support on top of `scheme-medium`.
   - The default now also covers a broader ML/NLP paper stack used by ICML, NeurIPS, ICLR, EMNLP and similar templates: `array.sty`, `tabularx.sty`, `multicol.sty`, `afterpage.sty` and `xspace.sty` via `tools`, `subcaption` via `caption`, `nicefrac` via `units`, `stfloats` via `sttools`, `balance` via `preprint`, `pifont` via `psnfss`, `newtxmath` via `newtx`, `extarticle` via `extsizes`, `xifthen` plus `ifmtarg`, `datetime` plus `fmtcount`, `XCharter` plus `fontaxes`, `forest` plus `elocalloc`, `changes` plus `xstring` and `truncate`, `bclogo` with `mdframed` and TikZ support via `pgf`, `epigraph` plus `nextpage`, `CJKutf8` via `cjk`, `textgreek` with Greek font support via `greek-fontenc`, `cbfonts`, and `cbfonts-fd`, `xurl.sty` via `xurl`, and `\forloop` via `forloop`, plus common packages for algorithms, lists, tables, fonts, notes, colors, headers/footers and hyperlinks.
   - Add more package names separated by spaces if your templates need them, for example `"collection-langcjk microtype tools caption booktabs multirow cleveref mathtools todonotes xcolor hyperref enumitem algorithms algorithmicx natbib url units wrapfig float sttools adjustbox threeparttable tablefootnote soul ulem listings pgfplots siunitx makecell preprint forloop xifthen cmap psnfss textcase changepage datetime fancyhdr lastpage titlesec needspace kvoptions tcolorbox fontawesome5 xcharter newtx zlmtt extsizes geometry colortbl minted"`.
   - If you change either TeX Live variable after the base image already exists, set `OVERLEAF_FORCE_BASE_REBUILD=true` for the next build.
   - Conference template files themselves such as `icml2026.sty`, `neurips_2026.sty`, `iclr2026_conference.sty`, or ACL/EMNLP style files are not installed from TeX Live. Those still need to live inside the project source tree.
   - The curated build-from-scratch package manifest is tracked in [texlive-packages.lumia.md](/Users/yxwang/Documents/codex_lumia/LUMIA-server-overleaf/deploy/texlive-packages.lumia.md).
9. `OVERLEAF_PHUSION_BASEIMAGE_TAG` controls the parent image used by [server-ce/Dockerfile-base](/Users/yxwang/Documents/codex_lumia/LUMIA-server-overleaf/server-ce/Dockerfile-base).
   - Default is `phusion/baseimage:noble-1.0.2`.
   - If your Docker daemon's mirror rate-limits Docker Hub, point this to a locally loaded image tag or another reachable registry path.

## Build

```bash
./deploy/build-image.sh ./deploy/overleaf.lumia.env
```

Notes:

- The build now uses the repo's local [server-ce/Dockerfile-base](/Users/yxwang/Documents/codex_lumia/LUMIA-server-overleaf/server-ce/Dockerfile-base), which installs Node 22 and npm 11.6.2.
- This avoids failures from stale external `sharelatex/sharelatex-base:latest` images that still carry Node 16.
- The first base-image build is heavy because it includes TeX Live. Later runs reuse the local Docker cache and the existing `lumia-overleaf-base:latest` image.
- If you intentionally want to rebuild the base image, set `OVERLEAF_FORCE_BASE_REBUILD=true` in the env file.
- If the build fails while pulling `phusion/baseimage:noble-1.0.2` with a mirror-side `429 Too Many Requests`, either retry later or load the image locally and point `OVERLEAF_PHUSION_BASEIMAGE_TAG` at that local tag.
- If TeX package installation fails near the end of a long `tlmgr install`, the visible final package line is often just the last meta-package processed, not the real failing dependency. Installing a larger built-in scheme first is usually more reliable.

## Deploy

```bash
./deploy/deploy.sh ./deploy/overleaf.lumia.env
```

If you previously started the stack with `mongo:6.0` and this is still a fresh deployment with no data you need to keep, remove the old Mongo data directory before redeploying so the new container can initialize cleanly:

```bash
rm -rf deploy/data/mongo
```

## Patch an already built image with extra TeX packages

If the site is already deployed and you only want to add a few missing TeX packages, you do not need to rebuild the full base image. Build a small derived image on top of the current Overleaf image instead:

```bash
./deploy/extend-texlive-image.sh ./deploy/overleaf.lumia.env tools
```

`array.sty` comes from the TeX Live `tools` package, so the command above is the direct fix for the error you posted.

After the derived image is built, point `OVERLEAF_IMAGE` at the new tag and restart the stack:

```bash
sed -i 's#^OVERLEAF_IMAGE=.*#OVERLEAF_IMAGE=lumia-overleaf:texlive-patched#' deploy/overleaf.lumia.env
docker compose --env-file deploy/overleaf.lumia.env -f deploy/docker-compose.lumia.yml up -d
```

This approach is useful for incremental fixes. For long-term reproducibility, also add the same packages to `OVERLEAF_TEXLIVE_EXTRA_PACKAGES` and rebuild the base image later.

## HTTPS

For public deployment, do not expose Overleaf itself directly on a public port with TLS disabled. The recommended layout is:

- Overleaf listens only on `127.0.0.1:${OVERLEAF_HTTP_PORT}`
- A host-level reverse proxy such as Nginx terminates TLS on `443`
- The proxy forwards requests to `http://127.0.0.1:${OVERLEAF_HTTP_PORT}`

Required Overleaf settings:

- `OVERLEAF_HTTP_BIND_IP=127.0.0.1`
- `OVERLEAF_SITE_URL=https://your-domain`
- `OVERLEAF_SECURE_COOKIE=true`
- Keep `OVERLEAF_TRUSTED_PROXY_IPS` including `loopback`

Why these matter:

- `OVERLEAF_SITE_URL` must use the final public `https://` origin so redirects, links, and callback URLs are generated correctly.
- `OVERLEAF_SECURE_COOKIE=true` makes session cookies carry the `Secure` flag.
- Overleaf already runs with `behindProxy: true`; it trusts proxy headers according to `OVERLEAF_TRUSTED_PROXY_IPS`.
- Your reverse proxy must send `X-Forwarded-Proto https`, `X-Forwarded-For`, and `Host`, and must preserve WebSocket upgrade headers for realtime collaboration.

A host Nginx example is provided in [overleaf-public.conf.example](/Users/yxwang/Documents/codex_lumia/LUMIA-server-overleaf/deploy/nginx/overleaf-public.conf.example).

Typical rollout:

```bash
sed -i 's#^OVERLEAF_HTTP_BIND_IP=.*#OVERLEAF_HTTP_BIND_IP=127.0.0.1#' deploy/overleaf.lumia.env
sed -i 's#^OVERLEAF_SITE_URL=.*#OVERLEAF_SITE_URL=https://overleaf.example.com#' deploy/overleaf.lumia.env
grep -q '^OVERLEAF_SECURE_COOKIE=' deploy/overleaf.lumia.env \
  && sed -i 's#^OVERLEAF_SECURE_COOKIE=.*#OVERLEAF_SECURE_COOKIE=true#' deploy/overleaf.lumia.env \
  || echo 'OVERLEAF_SECURE_COOKIE=true' >> deploy/overleaf.lumia.env

docker compose --env-file deploy/overleaf.lumia.env -f deploy/docker-compose.lumia.yml up -d
```

After that, install and enable a host-side TLS proxy using your certificate files.

## First admin bootstrap

When `EXTERNAL_AUTH=ldap` is enabled, self-service registration is disabled and LDAP login will not create new Overleaf users.

Use the launchpad page to create the first local Overleaf account record for the admin, then authenticate with LDAP:

```text
http://YOUR_HOST_OR_IP:38080/launchpad
```

## Pre-provision normal LDAP users

Normal LDAP users must already exist in Overleaf before they can log in. Two supported ways are:

- Invite them from an existing project, which creates a holding account that LDAP login can activate.
- Pre-create them with the helper script inside the running container:

```bash
docker exec -it lumia-overleaf bash -lc \
  "cd /overleaf/services/web && node scripts/provision_ldap_user.mjs --email=user@example.com"
```

You can also set names and admin status:

```bash
docker exec -it lumia-overleaf bash -lc \
  "cd /overleaf/services/web && node scripts/provision_ldap_user.mjs --email=user@example.com --first-name=Given --last-name=Family --admin"
```

## Batch sync Lumia LDAP users

If you want to bulk import LDAP users into Overleaf, use:

```bash
docker exec -it lumia-overleaf bash -lc \
  "cd /overleaf/services/web && node scripts/sync_ldap_users_to_overleaf.mjs"
```

Dry run:

```bash
docker exec -it lumia-overleaf bash -lc \
  "cd /overleaf/services/web && node scripts/sync_ldap_users_to_overleaf.mjs --dry-run"
```

Behavior:

- Search under `ou=People,dc=sugon,dc=com`
- Read `uid` and `cn`
- Create Overleaf users as `uid@lumia.cn`
- Set the Overleaf display name from `cn`
- LDAP login also resolves Overleaf accounts with the same `uid@lumia.cn` rule
- Leave existing Overleaf users untouched

## Enabled behavior

- LDAP login uses `192.168.102.101:389`.
- Only users already present in Overleaf can log in.
- Existing holding accounts are activated on first successful LDAP login.
- Review/comments UI is enabled with `OVERLEAF_ENABLE_COMMENTS=true`.
