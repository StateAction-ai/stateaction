// Content-keyed, sealed template databases on the bounded fixture PostgreSQL.
//
// A per-run database is cloned with CREATE DATABASE ... TEMPLATE from a
// template that already has the migrations (or a seeded catalog) applied,
// instead of re-applying them per database. Rules (SA-115):
//   * The template name carries its content key (`sa_tpl_<kind>_<key16>`), so
//     a changed migration/seed tree is a different name and is built fresh.
//   * Built once under a cluster-wide advisory lock into a staging database,
//     fingerprinted, sealed (IS_TEMPLATE, ALLOW_CONNECTIONS false, nobody can
//     connect and write) and only then renamed to its final name.
//   * Every clone is re-fingerprinted before it is returned; a template that
//     does not match its recorded fingerprint is dropped and rebuilt, and a
//     rebuilt template that still mismatches fails closed.
//   * Templates hold no test-written data, secrets or recordings. They are
//     shared across runs and are never reaped by a run ledger; the per-run
//     ledger records only a `template` event naming the key. Retention:
//     `pruneTemplates` drops comment-proven templates older than TEMPLATE_TTL_MS
//     whose key is not the one in use.
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const TEMPLATE_FORMAT = "1";
export const TEMPLATE_TTL_MS = 24 * 60 * 60 * 1000;
export const TEMPLATE_PREFIX = "sa_tpl_";
const MARK = "stateaction-template:";
const NAME = /^sa_tpl_[a-z][a-z0-9]{1,11}_[0-9a-f]{16}$/;
const STAGING = /^sa_tplb_[a-z][a-z0-9]{1,11}_[0-9a-f]{16}_[0-9a-f]{8}$/;

const ident = (n) => `"${String(n).replace(/"/g, '""')}"`;
const sha = (text) => createHash("sha256").update(text).digest("hex");

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Hash of the named files/directories (path + content), stable and sorted. */
export function contentKey(root, paths) {
  const h = createHash("sha256");
  h.update(`format:${TEMPLATE_FORMAT}\n`);
  const files = paths.flatMap((p) => {
    const abs = join(root, p);
    try {
      return walk(abs);
    } catch {
      return [abs];
    }
  });
  for (const f of files.sort()) {
    h.update(`${relative(root, f)}\n`);
    h.update(readFileSync(f));
    h.update("\n");
  }
  return h.digest("hex");
}

/** Key of the migrated schema: migration files plus the role/grant setup code. */
export function migrationKey(root) {
  return contentKey(root, [
    "packages/server/migrations",
    "packages/server/src/migrations.ts",
  ]);
}

export const templateName = (kind, key) => {
  const name = `${TEMPLATE_PREFIX}${kind}_${key.slice(0, 16)}`;
  if (!NAME.test(name))
    throw new Error(`invalid template kind/key for ${name}`);
  return name;
};

/** Exact, deterministic fingerprint of the schema and the row counts. */
export async function fingerprint(client) {
  const cols = await client.query(
    `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  );
  const idx = await client.query(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexdef",
  );
  const counts = await client.query(
    `SELECT table_name,
            (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text AS n
       FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const objects = await client.query(
    `SELECT 'fn' AS k, pg_get_functiondef(p.oid) AS d FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
     UNION ALL
     SELECT 'con', c.conrelid::regclass::text || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid)
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'
     UNION ALL
     SELECT 'trg', pg_get_triggerdef(t.oid) FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
     UNION ALL
     SELECT 'pol', schemaname || '.' || tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '')
       FROM pg_policies WHERE schemaname = 'public'
     UNION ALL
     SELECT 'rel', c.relname || ' ' || c.relkind::text || ' ' || pg_get_userbyid(c.relowner) || ' ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity::text
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'S', 'm')
     ORDER BY 1, 2`,
  );
  let migrations = [];
  try {
    migrations = (
      await client.query(
        "SELECT version, sha256 FROM platform_schema_migrations ORDER BY version",
      )
    ).rows;
  } catch {
    // Not migrated (an empty base template).
  }
  return sha(
    JSON.stringify({
      cols: cols.rows,
      idx: idx.rows,
      counts: counts.rows,
      objects: objects.rows,
      migrations,
    }),
  );
}

function lockIds(name) {
  const b = createHash("sha256").update(`sa-template:${name}`).digest();
  return [b.readInt32BE(0), b.readInt32BE(4)];
}

const LOCK_WAIT = "20min"; // bound on waiting for a builder (build itself <= BUILD_TIMEOUT_MS)
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/** Open the lock connection: waiting on a builder must not hit the driver's statement timeout. */
async function lockConnection(env) {
  const c = await env.connect(env.adminUrl);
  try {
    await c.query("SET statement_timeout = 0");
    await c.query(`SET lock_timeout = '${LOCK_WAIT}'`);
  } catch (error) {
    await c.end().catch(() => undefined);
    throw error;
  }
  return c;
}

const withDeadline = (promise, ms, what) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} exceeded ${ms} ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * @typedef {object} Env
 * @property {(url: string) => Promise<any>} connect pg client factory
 * @property {string} adminUrl
 * @property {string} ownerUrl
 * @property {string} appUrl
 * @property {(event: object) => void} [note]
 */

const withDb = (url, db) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

async function readComment(admin, name) {
  const { rows } = await admin.query(
    `SELECT d.datistemplate, d.datallowconn, shobj_description(d.oid, 'pg_database') AS comment
       FROM pg_database d WHERE d.datname = $1`,
    [name],
  );
  if (rows.length === 0) return null;
  const { comment, datistemplate, datallowconn } = rows[0];
  if (!comment?.startsWith(MARK)) return { sealed: false, meta: null };
  let meta = null;
  try {
    meta = JSON.parse(comment.slice(MARK.length));
  } catch {
    // Corrupt comment: treated as unsealed and rebuilt.
  }
  return { sealed: Boolean(datistemplate && !datallowconn && meta), meta };
}

export async function dropTemplate(admin, name) {
  if (!NAME.test(name) && !STAGING.test(name))
    throw new Error(`refusing to drop non-template database ${name}`);
  await admin
    .query(
      `ALTER DATABASE ${ident(name)} WITH IS_TEMPLATE false ALLOW_CONNECTIONS true`,
    )
    .catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
}

const ACL_SQL = `SELECT array_agg(x ORDER BY x) AS acl FROM pg_database d, unnest(d.datacl::text[]) x WHERE d.datname = $1`;

/**
 * CREATE DATABASE ... TEMPLATE copies objects but not the database-level ACL
 * (migrations revoke TEMPORARY and grant CONNECT per database), so replay the
 * template's ACL on the clone and require it to match exactly.
 */
async function replayDatabaseAcl(admin, template, name) {
  const { rows } = await admin.query(
    `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END AS grantee, a.privilege_type
       FROM pg_database d, aclexplode(d.datacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
      WHERE d.datname = $1 AND a.grantee <> d.datdba`,
    [template],
  );
  const want = (await admin.query(ACL_SQL, [template])).rows[0]?.acl ?? null;
  if (want === null) return;
  await admin.query(`REVOKE ALL ON DATABASE ${ident(name)} FROM PUBLIC`);
  for (const r of rows)
    if (r.grantee !== "PUBLIC")
      await admin.query(
        `REVOKE ALL ON DATABASE ${ident(name)} FROM ${r.grantee}`,
      );
  for (const r of rows)
    await admin.query(
      `GRANT ${r.privilege_type} ON DATABASE ${ident(name)} TO ${r.grantee}`,
    );
  const got = (await admin.query(ACL_SQL, [name])).rows[0]?.acl ?? null;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    await admin.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
    throw new TemplateMismatch(
      `${template} database ACL not reproduced on the clone`,
    );
  }
}

/**
 * Create a verified clone of `template`. Returns `{ name }` after the clone's
 * fingerprint matched the template's recorded one, or throws a
 * `TemplateMismatch` (the clone is dropped first).
 */
export class TemplateMismatch extends Error {}

export async function cloneVerified(
  env,
  template,
  { name, owner, comment, connectionLimit = 60 },
) {
  const admin = await lockConnection(env);
  try {
    // Shared lock: a build, rebuild, drop or prune of this template (exclusive)
    // cannot land between the seal check and CREATE DATABASE.
    const [l1, l2] = lockIds(template);
    let info;
    await admin.query("SELECT pg_advisory_lock_shared($1, $2)", [l1, l2]);
    try {
      info = await readComment(admin, template);
      if (!info?.sealed)
        throw new TemplateMismatch(`${template} is missing or not sealed`);
      await admin.query(
        `CREATE DATABASE ${ident(name)} OWNER ${ident(owner)} TEMPLATE ${ident(template)}`,
      );
    } finally {
      await admin.query("SELECT pg_advisory_unlock_shared($1, $2)", [l1, l2]);
    }
    await replayDatabaseAcl(admin, template, name);
    await admin.query(
      `ALTER DATABASE ${ident(name)} CONNECTION LIMIT ${Number(connectionLimit)}`,
    );
    if (comment)
      await admin.query(
        `COMMENT ON DATABASE ${ident(name)} IS '${String(comment).replace(/'/g, "''")}'`,
      );
    const probe = await env.connect(withDb(env.adminUrl, name));
    let actual;
    try {
      actual = await fingerprint(probe);
    } finally {
      await probe.end();
    }
    if (actual !== info.meta.fingerprint) {
      await admin.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
      throw new TemplateMismatch(
        `${template} fingerprint mismatch (recorded ${info.meta.fingerprint.slice(0, 12)}, clone ${actual.slice(0, 12)})`,
      );
    }
    return { name, meta: info.meta };
  } finally {
    await admin.end();
  }
}

/**
 * Ensure the sealed template for (kind, key) exists, building it once under an
 * advisory lock. `build({ name, ownerUrl, appUrl })` populates the staging
 * database (cloned from `base` when given, else empty) and returns JSON-safe
 * metadata that clones can read back.
 *
 * @returns {Promise<{ name: string, meta: any, reused: boolean }>}
 */
export async function ensureTemplate(
  env,
  { kind, key, base, build, now = Date.now(), log = () => {} },
) {
  const name = templateName(kind, key);
  const [l1, l2] = lockIds(name);
  const admin = await lockConnection(env);
  try {
    // Session-level lock held for the whole check/build: concurrent builders
    // wait here and then see the sealed template.
    await admin.query("SELECT pg_advisory_lock($1, $2)", [l1, l2]);
    try {
      const existing = await readComment(admin, name);
      if (existing?.sealed && existing.meta.key === key) {
        log(
          `template ${name} reused (key ${key.slice(0, 12)} fingerprint recorded)`,
        );
        return { name, meta: existing.meta, reused: true };
      }
      if (existing) {
        log(
          `template ${name} present but unsealed or stale: dropping to rebuild`,
        );
        await dropTemplate(admin, name);
      }
      const staging = `sa_tplb_${kind}_${key.slice(0, 16)}_${randomBytes(4).toString("hex")}`;
      try {
        if (base)
          await cloneVerified(env, base, {
            name: staging,
            owner: "migration_owner",
          });
        else
          await admin.query(
            `CREATE DATABASE ${ident(staging)} OWNER migration_owner`,
          );
        if (!base)
          await admin.query(
            `GRANT CONNECT ON DATABASE ${ident(staging)} TO ${ident(decodeURIComponent(new URL(env.appUrl).username))}`,
          );
        const userMeta =
          (await withDeadline(
            Promise.resolve(
              build({
                name: staging,
                ownerUrl: withDb(env.ownerUrl, staging),
                appUrl: withDb(env.appUrl, staging),
              }),
            ),
            BUILD_TIMEOUT_MS,
            `building template ${name}`,
          )) ?? null;
        const probe = await env.connect(withDb(env.adminUrl, staging));
        let fp;
        try {
          fp = await fingerprint(probe);
        } finally {
          await probe.end();
        }
        const meta = {
          format: TEMPLATE_FORMAT,
          kind,
          key,
          fingerprint: fp,
          builtAt: now,
          base: base ?? null,
          user: userMeta,
        };
        await admin.query(
          `COMMENT ON DATABASE ${ident(staging)} IS '${MARK}${JSON.stringify(meta).replace(/'/g, "''")}'`,
        );
        await admin.query(
          `ALTER DATABASE ${ident(staging)} WITH ALLOW_CONNECTIONS false CONNECTION LIMIT 0`,
        );
        await admin.query(`ALTER DATABASE ${ident(staging)} IS_TEMPLATE true`);
        await admin.query(
          `ALTER DATABASE ${ident(staging)} RENAME TO ${ident(name)}`,
        );
        log(
          `template ${name} built (key ${key.slice(0, 12)}, fingerprint ${fp.slice(0, 12)})`,
        );
        env.note?.({ template: name, key, built: true });
        return { name, meta, reused: false };
      } catch (error) {
        await dropTemplate(admin, staging).catch(() => undefined);
        throw error;
      }
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1, $2)", [l1, l2]);
    }
  } finally {
    await admin.end();
  }
}

/**
 * Clone a fresh database for one test file/worker. A mismatching template is
 * dropped and rebuilt once; a second mismatch fails closed.
 */
export async function cloneFromTemplate(env, spec, target) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const tpl = await ensureTemplate(env, spec);
    try {
      const out = await cloneVerified(env, tpl.name, target);
      env.note?.({ template: tpl.name, key: spec.key, reused: tpl.reused });
      return { ...out, reused: tpl.reused, template: tpl.name };
    } catch (error) {
      if (!(error instanceof TemplateMismatch)) throw error;
      lastError = error;
      spec.log?.(`${error.message}: rebuilding template`);
      const admin = await lockConnection(env);
      const [l1, l2] = lockIds(tpl.name);
      try {
        await admin.query("SELECT pg_advisory_lock($1, $2)", [l1, l2]);
        try {
          // Drop only the build that failed verification: if another worker
          // already rebuilt it (different fingerprint/builtAt), keep that one.
          const now = await readComment(admin, tpl.name);
          if (!now?.sealed || now.meta.fingerprint === tpl.meta.fingerprint)
            await dropTemplate(admin, tpl.name);
        } finally {
          await admin.query("SELECT pg_advisory_unlock($1, $2)", [l1, l2]);
        }
      } finally {
        await admin.end();
      }
    }
  }
  throw new Error(
    `template ${templateName(spec.kind, spec.key)} failed verification twice: ${lastError.message}`,
  );
}

/**
 * Retention: drop comment-proven templates older than the TTL, except `keep`
 * names, and orphaned staging databases of killed builds. Every drop happens
 * only after taking that template's advisory lock without waiting
 * (pg_try_advisory_lock): a template being built, rebuilt or cloned is skipped.
 */
export async function pruneTemplates(
  env,
  { keep = [], now = Date.now() } = {},
) {
  const admin = await lockConnection(env);
  const dropped = [];
  const underLock = async (finalName, fn) => {
    const [l1, l2] = lockIds(finalName);
    const { rows } = await admin.query(
      "SELECT pg_try_advisory_lock($1, $2) AS ok",
      [l1, l2],
    );
    if (!rows[0].ok) return;
    try {
      await fn();
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1, $2)", [l1, l2]);
    }
  };
  try {
    const { rows } = await admin.query(
      `SELECT datname FROM pg_database
        WHERE datname LIKE 'sa\\_tpl%' ESCAPE '\\' ORDER BY datname`,
    );
    for (const { datname } of rows) {
      if (STAGING.test(datname)) {
        // A staging database whose template lock is free has no live builder.
        const finalName = datname
          .replace(/^sa_tplb_/, "sa_tpl_")
          .replace(/_[0-9a-f]{8}$/, "");
        await underLock(finalName, async () => {
          await dropTemplate(admin, datname);
          dropped.push(datname);
        });
        continue;
      }
      if (!NAME.test(datname) || keep.includes(datname)) continue;
      await underLock(datname, async () => {
        const info = await readComment(admin, datname);
        if (!info?.meta || now - info.meta.builtAt < TEMPLATE_TTL_MS) return;
        await dropTemplate(admin, datname);
        dropped.push(datname);
      });
    }
  } finally {
    await admin.end();
  }
  return dropped;
}
