# Security policy

## Reporting a vulnerability

Do not open a public issue for a security problem.

Use GitHub private vulnerability reporting: the repository's **Security** tab,
then **Report a vulnerability**. If that is unavailable, write to
contact@stateaction.ai with a description, affected commit or version
and reproduction steps.

We acknowledge reports within 5 working days and aim to fix confirmed issues
within 90 days, coordinating disclosure with you.

## Scope

In scope: the web console and API (`apps/web`, `packages/server`), upload and
storage paths, authentication and authorization, the processing workers
(`workers/`) and the mobile recorder (`apps/mobile`, `packages/stera_recorder`).

Out of scope: findings that need a compromised device or maintainer account,
denial of service by volume against a self-hosted instance, and third-party
services (Render, Cloudflare R2, Modal) themselves.

## Handling secrets and recordings

Never include real credentials, recordings or images in a report. Redact tokens
and use synthetic data to demonstrate the issue. If you find a leaked secret in
this repository's history, report it privately so it can be rotated.
