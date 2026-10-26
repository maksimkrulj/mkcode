import { isMarkup, renderToString } from "./markup.js";
import { isResult } from "./result.js";

/** Parameter descriptor: `int`, `float`, `string`, `bool` or `json`, plus `?` when optional. */
export type ParamSpec = Record<string, string>;

interface Route {
  method: string;
  path: string;
  spec: ParamSpec;
  // `any`: each compiled handler destructures its own typed parameters.
  handler: (params: any) => unknown;
  pattern: RegExp;
  keys: string[];
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** Parsed JSON body (or the text, for HTML responses). */
  body: any;
  text: string;
}

const routes: Route[] = [];
let server: { close(cb?: () => void): void } | undefined;

function env(name: string): string | undefined {
  return (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[name];
}

/** Registers a compiled `route` declaration. */
export function route(method: string, path: string, spec: ParamSpec, handler: Route["handler"]): void {
  const keys: string[] = [];
  const source = path
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:([A-Za-z_]\w*)/g, (_, key: string) => {
      keys.push(key);
      return "([^/]+)";
    });
  routes.push({ method, path, spec, handler, pattern: new RegExp(`^${source}/?$`), keys });
}

/** Forgets registered routes (the playground runs many programs in one page). */
export function reset(): void {
  routes.length = 0;
}

export function listRoutes(): { method: string; path: string }[] {
  return routes.map(({ method, path }) => ({ method, path }));
}

class BadRequest extends Error {}

function coerce(name: string, raw: unknown, type: string): unknown {
  const optional = type.endsWith("?");
  const base = type.replace("?", "");
  if (raw === undefined || raw === null || raw === "") {
    if (optional) return undefined;
    throw new BadRequest(`missing parameter '${name}'`);
  }
  switch (base) {
    case "int": {
      const n = typeof raw === "number" ? raw : /^-?\d+$/.test(String(raw)) ? Number(raw) : NaN;
      if (!Number.isInteger(n)) throw new BadRequest(`parameter '${name}' must be an int`);
      return n;
    }
    case "float": {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new BadRequest(`parameter '${name}' must be a number`);
      return n;
    }
    case "bool":
      if (raw === true || raw === "true" || raw === "1") return true;
      if (raw === false || raw === "false" || raw === "0") return false;
      throw new BadRequest(`parameter '${name}' must be true or false`);
    case "string":
      if (typeof raw === "object") throw new BadRequest(`parameter '${name}' must be a string`);
      return String(raw);
    default:
      return raw;
  }
}

function json(status: number, body: unknown): HttpResponse {
  const text = JSON.stringify(body);
  return { status, ok: status < 400, headers: { "content-type": "application/json; charset=utf-8" }, body, text };
}

/** Routes a request through the registered handlers — no network involved. */
export async function dispatch(method: string, url: string, bodyText?: string): Promise<HttpResponse> {
  const { pathname, searchParams } = new URL(url, "http://mk.local");
  const matches = routes.filter((r) => r.pattern.test(pathname));
  if (!matches.length) return json(404, { error: `no route for ${pathname}` });
  const found = matches.find((r) => r.method === method.toUpperCase());
  if (!found) return json(405, { error: `${method} is not allowed on ${pathname}`, allowed: matches.map((r) => r.method) });

  try {
    const raw: Record<string, unknown> = Object.fromEntries(searchParams);
    if (bodyText) {
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        throw new BadRequest("request body must be JSON");
      }
      if (body && typeof body === "object" && !Array.isArray(body)) Object.assign(raw, body);
    }
    const values = found.pattern.exec(pathname)!.slice(1);
    found.keys.forEach((key, i) => (raw[key] = decodeURIComponent(values[i]!)));

    const params: Record<string, unknown> = {};
    for (const [name, type] of Object.entries(found.spec)) params[name] = coerce(name, raw[name], type);
    return respond(await found.handler(params));
  } catch (e) {
    if (e instanceof BadRequest) return json(400, { error: e.message });
    return json(500, { error: (e as Error)?.message ?? String(e) });
  }
}

function respond(result: unknown): HttpResponse {
  if (result === undefined) return { status: 204, ok: true, headers: {}, body: null, text: "" };
  if (result === null) return json(404, { error: "not found" });
  if (isResult(result)) return result.tag === "Ok" ? respond(result.value ?? undefined) : json(400, { error: result.error });
  if (isMarkup(result)) {
    const text = `<!doctype html>${renderToString(result)}`;
    return { status: 200, ok: true, headers: { "content-type": "text/html; charset=utf-8" }, body: text, text };
  }
  return json(200, result);
}

/** `request("GET", "/todos")` — calls your own routes in-process (great for tests). */
export async function request(method: string, path: string, body?: unknown): Promise<HttpResponse> {
  return dispatch(method, path, body === undefined ? undefined : JSON.stringify(body));
}

/** Starts an HTTP server for the declared routes. */
export async function serve(port = Number(env("PORT") ?? 3000)): Promise<void> {
  if (!(globalThis as { process?: unknown }).process || (globalThis as { document?: unknown }).document) {
    console.log(`(no network in the browser) ${routes.length} route(s) ready — call them with request(method, path)`);
    return;
  }
  if (server) return;
  const { createServer } = await import("node:http");
  const srv = createServer(async (req, res) => {
    const started = Date.now();
    let body = "";
    for await (const chunk of req) body += chunk;
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE" }).end();
      return;
    }
    const r = await dispatch(req.method ?? "GET", req.url ?? "/", body || undefined);
    res.writeHead(r.status, { ...r.headers, ...cors }).end(r.text);
    console.error(`${req.method} ${req.url} ${r.status} ${Date.now() - started}ms`);
  });
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, resolve);
  });
  server = srv;
  console.log(`MK server listening on http://localhost:${port}`);
  for (const r of routes) console.log(`  ${r.method.padEnd(6)} ${r.path}`);
}

/** Emitted at the end of entry modules with routes: serves when started by `mk serve`. */
export async function autoServe(): Promise<void> {
  const port = env("MK_SERVE_PORT");
  if (port && !server) await serve(Number(port));
}

export async function close(): Promise<void> {
  const s = server;
  server = undefined;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
}
