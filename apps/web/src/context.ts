import type { Context as ApiContext } from "@Kavero/api/context";
import type { NextRequest } from "next/server";

import { deleteUnreferencedObjects, objectStorage, testObjectStorage } from "./modules/storage/object-storage";
import { ENV } from "./env.server";
import { allowPrivateUrls, platform, runtimeConfig, secretBox, serverAiProvider } from "./platform";
import { auth, db } from "./services";

export async function createContext(req: NextRequest): Promise<ApiContext> {
  const [session, ai, allowLocalUrls] = await Promise.all([
    auth.api.getSession({ headers: req.headers }),
    serverAiProvider(),
    allowPrivateUrls(),
  ]);
  return {
    db,
    session,
    auth,
    headers: req.headers,
    secretBox,
    ai,
    appUrl: ENV.BETTER_AUTH_URL,
    allowLocalUrls,
    config: runtimeConfig,
    platform,
    testStorage: testObjectStorage,
    deleteObjects: (keys) => deleteUnreferencedObjects(db, keys),
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
