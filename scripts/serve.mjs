// Minimal static server for the playground: `npm run playground` → http://localhost:5173
import { createReadStream, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.PORT ?? 5173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
};

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/") {
      res.writeHead(302, { location: "/playground/" }).end();
      return;
    }
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (statSync(file).isDirectory()) {
        if (!url.pathname.endsWith("/")) {
          res.writeHead(301, { location: `${url.pathname}/` }).end();
          return;
        }
        file = path.join(file, "index.html");
      }
      statSync(file);
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`MK playground → http://localhost:${port}/playground/`));
