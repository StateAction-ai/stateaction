// Real SA-13 catalog for auth tests: the published migrator and local seed
// run with the migration owner credential; the extra pending and disabled
// identities are operator rows written with that same owner credential. The
// web runtime later connects only as the restricted `stateaction_app` role.
import pg from "pg";
import { hashCredentialPassword } from "../src/catalog/password.js";
import { SEED, seedLocalCatalog } from "../src/catalog/seed.js";
import { migrateDatabase } from "../src/migrations.js";

export type CatalogUserLabel =
  | "collector"
  | "staff"
  | "customer"
  | "outsider"
  | "pending"
  | "disabled";
export type CatalogUsers = Record<
  CatalogUserLabel,
  { id: string; email: string }
>;

/** Operator action: a credential identity with optional access rows. */
export async function createOperatorIdentity(
  owner: pg.Pool,
  input: {
    id: string;
    email: string;
    name: string;
    password: string;
    grants: { role: string; enabled: boolean }[];
  },
): Promise<void> {
  await owner.query(
    `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)`,
    [input.id, input.name, input.email],
  );
  await owner.query(
    `INSERT INTO account (id, "accountId", "providerId", "userId", password, "updatedAt")
     VALUES ($1, $2, 'credential', $2, $3, now())`,
    [
      `${input.id}-credential`,
      input.id,
      await hashCredentialPassword(input.password),
    ],
  );
  for (const grant of input.grants)
    await owner.query(
      "INSERT INTO access (user_id, role, enabled, granted_by) VALUES ($1, $2, $3, 'sa15-test-operator')",
      [input.id, grant.role, grant.enabled],
    );
}

export async function bootstrapCatalog(
  ownerUrl: string,
  password: string,
): Promise<{ users: CatalogUsers; appRoleGranted: boolean }> {
  const report = await migrateDatabase({ ownerUrl });
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  try {
    const seeded = await seedLocalCatalog(owner, { password });
    if (!seeded.seeded || !seeded.credentialAccounts)
      throw new Error("Expected a fresh seed with credential accounts");
    await createOperatorIdentity(owner, {
      id: "sa15-pending-1",
      email: "pending@stateaction.local",
      name: "Pending Identity",
      password,
      grants: [],
    });
    await createOperatorIdentity(owner, {
      id: "sa15-disabled-1",
      email: "disabled@stateaction.local",
      name: "Disabled Identity",
      password,
      grants: [{ role: "collector", enabled: false }],
    });
  } finally {
    await owner.end();
  }
  const { collector, staff, customer, outsider } = SEED.users;
  return {
    appRoleGranted: report.appRoleGranted,
    users: {
      collector: { id: collector.id, email: collector.email },
      staff: { id: staff.id, email: staff.email },
      customer: { id: customer.id, email: customer.email },
      outsider: { id: outsider.id, email: outsider.email },
      pending: { id: "sa15-pending-1", email: "pending@stateaction.local" },
      disabled: { id: "sa15-disabled-1", email: "disabled@stateaction.local" },
    },
  };
}
