// Used by the Next E2E: migrate + seed with CATALOG_OWNER_URL and print the
// seeded user IDs. The password comes from AUTH_TEST_PASSWORD; nothing secret
// is printed.
import { bootstrapCatalog } from "./catalog-bootstrap.js";

const ownerUrl = process.env.CATALOG_OWNER_URL;
const password = process.env.AUTH_TEST_PASSWORD;
if (!ownerUrl || !password)
  throw new Error("CATALOG_OWNER_URL and AUTH_TEST_PASSWORD are required");
const { users, appRoleGranted } = await bootstrapCatalog(ownerUrl, password);
if (!appRoleGranted) throw new Error("stateaction_app grants were not applied");
process.stdout.write(JSON.stringify(users));
