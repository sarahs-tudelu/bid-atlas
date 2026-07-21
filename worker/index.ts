/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runDueSourceMonitors } from "../app/lib/source-monitors/service";
import { runIngestion } from "./ingestion";
import { runJurisdictionDiscovery } from "./jurisdiction-discovery";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  DOCUMENTS?: R2Bucket;
  INGEST_TOKEN?: string;
  SAM_API_KEY?: string;
  DATA_GOV_API_KEY?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

function runScheduledWork(env: Env, ctx: ExecutionContext): void {
  // Keep these as independent platform lifetime promises. A slow or failed
  // ingestion pass must not suppress jurisdiction discovery, and vice versa.
  ctx.waitUntil(runIngestion(env, "incremental"));
  ctx.waitUntil(runJurisdictionDiscovery(env, { trigger: "scheduled" }));
  ctx.waitUntil(runDueSourceMonitors(env.DB));
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    if (url.pathname === "/api/internal/ingest" && request.method === "POST") {
      if (!env.INGEST_TOKEN) {
        return Response.json(
          { error: "INGEST_TOKEN is not configured." },
          { status: 503 },
        );
      }
      if (request.headers.get("authorization") !== `Bearer ${env.INGEST_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const mode = url.searchParams.get("mode") === "bootstrap" ? "bootstrap" : "incremental";
      ctx.waitUntil(runIngestion(env, mode));
      return Response.json(
        { accepted: true, mode, message: "Ingestion started in the background." },
        { status: 202 },
      );
    }

    if (url.pathname === "/api/internal/discover" && request.method === "POST") {
      if (!env.INGEST_TOKEN) {
        return Response.json(
          { error: "INGEST_TOKEN is not configured." },
          { status: 503 },
        );
      }
      if (request.headers.get("authorization") !== `Bearer ${env.INGEST_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const rawBatchSize = url.searchParams.get("limit");
      const requestedBatchSize = rawBatchSize === null ? Number.NaN : Number(rawBatchSize);
      const batchSize = Number.isFinite(requestedBatchSize) ? requestedBatchSize : undefined;
      ctx.waitUntil(
        runJurisdictionDiscovery(env, {
          trigger: "manual",
          batchSize,
        }),
      );
      return Response.json(
        {
          accepted: true,
          catalogMode: env.DATA_GOV_API_KEY?.trim()
            ? "keyed-gsa-v4"
            : "public-catalog-fallback",
          message:
            "Jurisdiction discovery started. Results remain review candidates until a live connector is separately verified.",
        },
        { status: 202 },
      );
    }

    return handler.fetch(request, env, ctx);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    runScheduledWork(env, ctx);
  },
};

export default worker;
