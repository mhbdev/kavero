import { initPlatform } from "../src/platform";
import { runMediaWorker } from "../src/modules/ai/media-jobs";

await initPlatform({ runtime: "worker" });
await runMediaWorker();
