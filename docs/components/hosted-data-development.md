# Preview hosted data locally

`pnpm dev:hosted` runs Next on `http://127.0.0.1:3008`. It reads the production catalog and the private `stateaction-prod` bucket. The banner on every page identifies the data source and whether writes are enabled. Better Auth and the temporary preview account live in a throwaway local database. The account uses the ID of an enabled hosted staff member so the catalog's normal staff checks still apply.

## One-time operator setup

Apply the [cached import migration and release](cached-processing-imports.md) first. Use an authorized hosted window for Postgres setup. The database command creates the dedicated login `stateaction_dev_reader` and verifies its grants, INSERT refusal and the read-only session's refusal to create large objects. It writes `~/.config/stateaction/hosted-dev-db.env` with mode 0600. Skip this command if the verified role and file already exist.

```sh
agent-resource run -- python3 scripts/platform/render_db_session.py \
  --owner-env CACHED_IMPORT_OWNER_DATABASE_URL -- \
  node scripts/platform/provision-hosted-reader.mjs contact@stateaction.ai
```

In Cloudflare R2, create an account token named `stateaction-hosted-dev-reader` with Object Read only on `stateaction-prod`. Save the dashboard's S3 endpoint, Access Key ID and Secret Access Key in `~/.config/stateaction/r2-prod-read.env` with mode 0600. Use the format below with your settings. [Cloudflare R2 authentication](https://developers.cloudflare.com/r2/api/tokens/)

```dotenv
R2_BUCKET=stateaction-prod
R2_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=READER_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=READER_SECRET_ACCESS_KEY
```

```sh
agent-resource run -- python3 scripts/platform/provision_hosted_r2_reader.py
```

The command checks the production endpoint against `~/.config/stateaction/r2-prod.env`, verifies an S3 list and range read, and requires the bucket to refuse a PUT to a unique probe key. On success it writes `~/.config/stateaction/hosted-dev.env` with mode 0600. Revoke the named reader token in the Cloudflare dashboard. A database owner can revoke the role's grants and drop the dedicated login. The genuine-run Recipe page reads the closure's `job_id`, `closed_at`, and `outcome` through a column-level grant on `public.job_output_closures`.

## Renew the R2 credential

Stop open preview sessions. Create a replacement Object Read token for `stateaction-prod` before the current token expires and update `r2-prod-read.env` with mode 0600. Keep the old `hosted-dev.env` as a private backup while rerunning `provision_hosted_r2_reader.py`. Once the verification passes, revoke the old token in Cloudflare and remove its superseded local credential backup.

## Use the profile

With the local database fixture running, set `STATEACTION_LOCAL_FIXTURES` to its configuration file and run:

```sh
agent-resource run -- pnpm dev:hosted
```

Enter a temporary local password at the prompt. Open `http://127.0.0.1:3008/login` and sign in as `hosted-preview@stateaction.local`. Set `--port` to choose another loopback port and `--seconds` to set the session timeout, from 60 to 3,600 seconds. The command refuses CI, checks the database role, and permits only storage reads. Browser media requests use short-lived loopback tickets, backed by presigned R2 GETs and checked against the local staff session.

The launcher adds only the workstation's current IPv4 address and verifies removal at exit, including timeout and normal termination signals. Render does not expire database ACL entries itself. After a hard kill or failed cleanup, check the named `stateaction-session` /32 on the database's Networking tab and remove that exact rule. [Render Postgres access control](https://render.com/docs/postgresql-creating-connecting#restricting-external-access)

Use a write session only with recorded authorization for the intended hosted changes. For an approved write session, `pnpm dev:hosted --allow-writes` requires a separately supplied 0600 `~/.config/stateaction/hosted-dev-write.env` with the same five variable names, the hosted `stateaction_app` connection and separately authorized R2 credentials. The default reader credential file has no write settings.
