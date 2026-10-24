import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareSiteAssets } from "./site-assets.mjs";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

function parsePort(argv) {
  let raw = null;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") {
      raw = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--port=")) {
      raw = arg.slice("--port=".length);
    }
  }
  if (raw === null) {
    return 4173;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port 需要 1-65535 之间的整数，收到: ${raw}`);
  }
  return port;
}

function resolveRequestPath(siteRoot, requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
  const relative = pathname.replace(/^\/+/, "");
  const target = path.resolve(siteRoot, relative);
  const rootWithSeparator = siteRoot.endsWith(path.sep) ? siteRoot : siteRoot + path.sep;
  if (target !== siteRoot && !target.startsWith(rootWithSeparator)) {
    return null;
  }
  if (existsSync(target) && statSync(target).isDirectory()) {
    return path.join(target, "index.html");
  }
  return target;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = path.join(repoRoot, "site");

const { copied } = prepareSiteAssets(repoRoot);
console.log(`素材已就绪: ${copied} 个文件（site/assets/）`);

const port = parsePort(process.argv);

const server = createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method Not Allowed");
    return;
  }

  const filePath = resolveRequestPath(siteRoot, request.url || "/");
  if (!filePath) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not Found");
    return;
  }

  const stats = statSync(filePath);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Content-Length": stats.size,
    "Cache-Control": "no-store",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    response.destroy();
  });
  stream.pipe(response);
});

server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.error(`端口 ${port} 已被占用，换一个 --port 再试。`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  console.log(`预览地址: http://127.0.0.1:${port}/`);
  console.log("按 Ctrl+C 停止。");
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
