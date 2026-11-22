import { platform, runtimeConfig } from "@/platform";
import { maxExportBytes } from "@/modules/export/access";

export const runtime = "nodejs";

/**
 * Settings the browser needs at runtime (so they can change in Admin → System
 * without rebuilding). Only public values: never add credentials here.
 */
export async function GET() {
  const [media] = await Promise.all([runtimeConfig.values("media"), runtimeConfig.values("exports")]);
  return Response.json(
    {
      edition: platform.edition,
      features: platform.features,
      media: {
        openverseEnabled: media.openverseEnabled === true,
        // GIPHY keys are public by design: GIPHY's browser SDKs use them directly.
        giphyApiKey: typeof media.giphyApiKey === "string" ? media.giphyApiKey.trim() : "",
      },
      // Largest PDF/image/video export upload, so the editor can warn before sending.
      exports: {
        // This is the effective request cap after applying the Vercel platform limit.
        maxRequestMb: Math.floor(maxExportBytes() / (1024 * 1024)),
        videoEnabled: process.env.VERCEL !== "1",
      },
    },
    { headers: { "Cache-Control": "public, max-age=30" } },
  );
}
