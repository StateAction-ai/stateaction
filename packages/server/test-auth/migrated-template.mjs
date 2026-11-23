// The shared migrated template: key = migrations + role/grant setup code.
// Used by the catalog harness (in-process migrate) and the Next/jobs/mobile
// harnesses (migrate through a tsx child), both producing the same template.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrationKey } from "../../../scripts/platform/db-template.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const serverDir = fileURLToPath(new URL("../", import.meta.url));

export function migratedSpec({ migrate, log } = {}) {
  return {
    kind: "mig",
    key: migrationKey(root),
    log,
    async build({ ownerUrl }) {
      if (migrate) {
        await migrate(ownerUrl);
        return null;
      }
      const child = spawnSync(
        process.execPath,
        [
          "--conditions=react-server",
          "--import",
          "tsx",
          "test-auth/migrate-cli.ts",
        ],
        {
          cwd: serverDir,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            CATALOG_OWNER_URL: ownerUrl,
          },
          encoding: "utf8",
          timeout: 120_000,
        },
      );
      if (child.status !== 0)
        throw new Error(
          `template migration failed: ${child.stderr?.trim() || child.error}`,
        );
      return null;
    },
  };
}
