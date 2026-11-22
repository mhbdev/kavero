import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { attachmentHeader, safeFileName } from "@Kavero/catalog-engine";

import { getJob } from "@/modules/export/video-jobs";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  if (process.env.VERCEL === "1") return Response.json({ error: "MP4 export jobs are unavailable on Vercel." }, { status: 503 });
  const job = getJob((await params).jobId);
  if (!job || job.status !== "done") return Response.json({ error: "Video not ready." }, { status: 404 });
  return new Response(Readable.toWeb(createReadStream(job.file)) as ReadableStream, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(job.bytes ?? ""),
      "Content-Disposition": attachmentHeader(safeFileName(job.title, "mp4")),
      "Cache-Control": "no-store",
    },
  });
}
