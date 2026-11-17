import { JobsApi } from "./api-client.js";
import { apiUrl, dispatchToken } from "./config.js";
import { dispatchOnce } from "./dispatcher.js";

// Run by the cron/operator with a repair-scoped credential; prints no secrets.
const api = new JobsApi(apiUrl(), dispatchToken(), 15_000);
console.log(JSON.stringify(await dispatchOnce(api)));
