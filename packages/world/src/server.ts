/** The regulator websites over HTTP. The season clock is set through an admin route that only the
 * harness uses; crawlers see ordinary pages, a sitemap, a load-more API when the layout has one,
 * maintenance pages on maintenance days and 429s when they ask too fast on a busy day. */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { MAINTENANCE, renderApiList, renderDoc, renderListing, renderSitemap } from "./sites.js";
import { type World, docLayout, layoutOf, shownAt } from "./world.js";

export type WorldServer = {
  url: string;
  server: Server;
  setDay: (d: number) => void;
  requests: () => number;
  close: () => Promise<void>;
};

const BUDGET_PER_SECOND = 4; // on a rate-limited day

export async function serveWorld(w: World, port = 0): Promise<WorldServer> {
  let day = 0;
  let count = 0;
  let windowStart = Date.now();
  let windowCount = 0;
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    count++;
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/__clock") {
      day = Number(url.searchParams.get("day") ?? day);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ day }));
      return;
    }
    const [, srcId, ...rest] = url.pathname.split("/");
    const src = w.sources.find((s) => s.id === srcId);
    if (!src) return void res.writeHead(404).end("not found");
    const html = (body: string, code = 200) =>
      res.writeHead(code, { "content-type": "text/html; charset=utf-8" }).end(body);
    if (src.rateLimited.includes(day)) {
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        windowCount = 0;
      }
      if (++windowCount > BUDGET_PER_SECOND)
        return void res.writeHead(429, { "retry-after": "1" }).end("Too Many Requests");
    }
    if (src.maintenance.includes(day)) return html(MAINTENANCE(src.name));
    const l = layoutOf(src, day);
    const docs = shownAt(w, src.id, day);
    const path = rest.join("/");
    if (path === "sitemap.xml") {
      if (!l.sitemap) return void res.writeHead(404).end("not found");
      return void res.writeHead(200, { "content-type": "application/xml" }).end(renderSitemap(src.id, docs));
    }
    if (path === "api/list") {
      if (l.pagination !== "api") return void res.writeHead(404).end("not found");
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return void res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(renderApiList(src.id, docs, l, offset)));
    }
    if (path.startsWith("doc/")) {
      const ref = decodeURIComponent(path.slice(4));
      const d = docs.find((x) => x.ref === ref);
      return d
        ? html(renderDoc(src.name, d, docLayout(w, src, day, d.ref)))
        : html("<h1>Not found</h1>", 404);
    }
    let pageNo = 1;
    if (path.startsWith("page/") && l.pagination === "path") pageNo = Number(path.slice(5));
    else if (path === "" && l.pagination === "query") pageNo = Number(url.searchParams.get("page") ?? 1);
    else if (path !== "") return html("<h1>Not found</h1>", 404);
    const { html: body, pages } = renderListing(src.name, src.id, docs, l, pageNo);
    if (pageNo > pages) return html("<h1>Not found</h1>", 404);
    return html(body);
  };
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`;
  return {
    url,
    server,
    setDay: (d) => {
      day = d;
    },
    requests: () => count,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
