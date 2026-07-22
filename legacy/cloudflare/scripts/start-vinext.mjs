import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", short: "p" },
    hostname: { type: "string", short: "H" },
  },
});

const port = Number(values.port ?? process.env.PORT ?? 3000);
const host = values.hostname ?? process.env.HOST ?? "0.0.0.0";

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("The BidAtlas server port must be an integer from 1 to 65535.");
}

// vinext 0.0.50 stores path.relative() output as a URL cache key. Windows
// returns backslashes, so built CSS and JavaScript otherwise return 404. Keep
// the compatibility adjustment inside this process; no installed package is
// modified. The wrapper can be removed after the network-workspace build is
// compatible with a vinext release containing the upstream separator fix.
const originalRelative = path.relative;
try {
  path.relative = (from, to) =>
    originalRelative(from, to).split(path.sep).join("/");
  const { startProdServer } = await import("vinext/server/prod-server");
  await startProdServer({
    port,
    host,
    outDir: path.resolve("dist"),
  });
} finally {
  path.relative = originalRelative;
}
