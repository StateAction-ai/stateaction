// Builds the migrated template: apply the migrations with the owner credential
// (CATALOG_OWNER_URL) exactly as production does. Nothing secret is printed.
import { migrateDatabase } from "../src/migrations.js";

const ownerUrl = process.env.CATALOG_OWNER_URL;
if (!ownerUrl) throw new Error("CATALOG_OWNER_URL is required");
const report = await migrateDatabase({ ownerUrl });
if (!report.appRoleGranted)
  throw new Error("stateaction_app grants were not applied");
process.stdout.write(`Schema ready: applied [${report.applied.join(",")}]\n`);
