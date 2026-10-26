# Security Policy

## Reporting a vulnerability

Please **do not open a public issue**. Instead, use GitHub's private vulnerability reporting:
go to the **Security** tab and click **Report a vulnerability**. You'll get a reply within a few
days.

## Areas that matter most

- **SQL generation** (`src/runtime/query.ts`, `src/runtime/db.ts`). Values must always be passed
  as bound parameters. Any way to get user data into the SQL text itself is a vulnerability.
- **URL import cache** (`src/cli/UrlCache.ts`). Each cached download is checked against its
  SHA-256 hash in `.mk_cache/manifest.json`. A way to make tampered content run without
  `--reload` is a vulnerability.
- **Generated code**. A way for a crafted `.mk` source to produce JavaScript that does something
  other than what its MK code says (for example through string or template escaping) is a
  vulnerability.

## Supported versions

Only the latest release gets security fixes while MK is at version 0.x.
