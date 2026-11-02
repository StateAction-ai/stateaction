// TEST-ONLY bootstrap for an isolated auth database. The schema comes from
// Better Auth 1.7.15's own migration generator (the same DDL SA-13 verified),
// and identities are created through Better Auth's internal adapter with its
// own password hasher. This is not the SA-13 migrator, seed or access table.
import { writeFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import type { Auth } from "../src/auth/instance.js";
import type { AccessGrant } from "../src/auth/access.js";

export async function migrateAuthSchema(auth: Auth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

export async function createIdentity(
  auth: Auth,
  input: { email: string; name: string; password: string },
): Promise<{ id: string; email: string }> {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({
    email: input.email,
    name: input.name,
    emailVerified: true,
  });
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await ctx.password.hash(input.password),
  });
  return { id: user.id, email: user.email };
}

export const TEST_IDENTITIES = {
  collector: [{ role: "collector", enabled: true }],
  staff: [{ role: "staff", enabled: true }],
  customer: [{ role: "customer", enabled: true }],
  multi: [
    { role: "collector", enabled: true },
    { role: "staff", enabled: false },
  ],
  pending: [],
  disabled: [{ role: "collector", enabled: false }],
} satisfies Record<string, AccessGrant[]>;
export type IdentityLabel = keyof typeof TEST_IDENTITIES;

export async function seedTestIdentities(
  auth: Auth,
  password: string,
  fixtureFile: string,
): Promise<Record<IdentityLabel, { id: string; email: string }>> {
  const users = {} as Record<IdentityLabel, { id: string; email: string }>;
  const fixture: Record<string, AccessGrant[]> = {};
  for (const [label, grants] of Object.entries(TEST_IDENTITIES)) {
    const user = await createIdentity(auth, {
      email: `${label}@auth-test.invalid`,
      name: `Test ${label}`,
      password,
    });
    users[label as IdentityLabel] = user;
    if (grants.length) fixture[user.id] = grants;
  }
  await writeFile(fixtureFile, JSON.stringify(fixture, null, 2));
  return users;
}
