import { createHash } from "node:crypto";
/** The incident sandbox: everything a repair agent may see, and nothing else. It holds the broken
 * scraper (the only file it may change), the helpers it imports, a sample of the pages the site
 * serves now, the last good extraction, and a check command that runs the scraper on those pages
 * through the same contract production uses. The rest of the pages stay outside, for the gates. */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type CrawlData, type Finding, type Page, ROOT, httpFetch } from "@rif/ingest";

export type Incident = {
  id: string;
  source: string;
  day: number;
  today: string;
  findings: Finding[];
  lastGood: CrawlData | null;
  pages: Record<string, Page>; // every page the evidence crawl fetched
};

/** Fetch what the site serves now, without a scraper: the listing, every page it links to, any
 * load-more endpoint, and every document in the sitemap. */
export async function evidenceCrawl(base: string, source: string, limit = 60): Promise<Record<string, Page>> {
  const rec = new Map<string, Page>();
  const fetch = httpFetch(base, source, rec);
  const queue = ["/", "/sitemap.xml"];
  const seen = new Set<string>();
  while (queue.length && seen.size < limit) {
    const path = queue.shift() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    let page: Page;
    try {
      page = await fetch(path);
    } catch {
      continue;
    }
    const body = page.body;
    for (const m of body.matchAll(/(?:href|<loc>)=?"?(\/[^"<\s]+)/g)) {
      const link = (m[1] as string).replace(new RegExp(`^/${source}`), "") || "/";
      if (link.startsWith("/") && !seen.has(link)) queue.push(link);
    }
    for (const m of body.matchAll(/data-endpoint="([^"]+)"\s+data-offset="(\d+)"/g)) {
      const ep = (m[1] as string).replace(new RegExp(`^/${source}`), "");
      queue.push(`${ep}?offset=${m[2]}`);
    }
    if (page.contentType.includes("json")) {
      try {
        const j = JSON.parse(body) as { next?: number | null; items?: { url?: string }[] };
        if (j.next !== null && j.next !== undefined) queue.push(`${path.split("?")[0]}?offset=${j.next}`);
        for (const it of j.items ?? []) if (it.url) queue.push(it.url.replace(new RegExp(`^/${source}`), ""));
      } catch {}
    }
  }
  return Object.fromEntries(rec);
}

/** Split the evidence: the agent sees every listing and API page and a few documents; the gates
 * check the scraper on all of them. */
export function splitPages(
  pages: Record<string, Page>,
  docsVisible: number,
): { visible: Record<string, Page>; hidden: Record<string, Page> } {
  const visible: Record<string, Page> = {};
  const hidden: Record<string, Page> = {};
  let docs = 0;
  for (const [k, p] of Object.entries(pages).sort(([a], [b]) => a.localeCompare(b))) {
    if (k.startsWith("/doc/")) {
      if (docs < docsVisible) {
        visible[k] = p;
        docs++;
      } else hidden[k] = p;
    } else visible[k] = p;
  }
  return { visible, hidden };
}

export const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export type Sandbox = { dir: string; bin: string; scraper: string; locked: Record<string, string> };

/** Lay out the sandbox for an incident. `code` is the scraper as deployed now. */
export function makeSandbox(
  workDir: string,
  inc: Incident,
  code: string,
  visible: Record<string, Page>,
): Sandbox {
  const dir = join(workDir, inc.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "scrapers"), { recursive: true });
  mkdirSync(join(dir, "config"), { recursive: true });
  const ingest = join(ROOT, "packages/ingest/src");
  for (const f of ["parse.ts", "types.ts", "contract.ts", "fetch.ts"]) cpSync(join(ingest, f), join(dir, f));
  cpSync(join(ROOT, "config/contracts.yaml"), join(dir, "config/contracts.yaml"));
  cpSync(join(ingest, "check.ts"), join(dir, "check.ts"));
  writeFileSync(join(dir, "scrapers", `${inc.source}.ts`), code);
  writeFileSync(
    join(dir, "snapshots.json"),
    JSON.stringify({ source: inc.source, today: inc.today, pages: visible }, null, 1),
  );
  writeFileSync(
    join(dir, "last-good.json"),
    JSON.stringify(inc.lastGood ?? { items: [], docs: [] }, null, 1),
  );
  writeFileSync(join(dir, "INCIDENT.md"), incidentText(inc, visible));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
        },
        include: ["scrapers", "*.ts"],
      },
      null,
      1,
    ),
  );
  if (!existsSync(join(dir, "node_modules")))
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  const bin = join(workDir, `${inc.id}-bin`);
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "rif-check"),
    `#!/bin/sh\n# Run the scraper on the snapshot pages through the production contract. Usage: rif-check\ncd "${dir}" || exit 2\nexec env -i PATH="$PATH" HOME=/tmp RIF_ROOT="${dir}" "${join(ROOT, "node_modules/.bin/tsx")}" check.ts snapshots.json\n`,
  );
  chmodSync(join(bin, "rif-check"), 0o755);
  const locked: Record<string, string> = {};
  for (const f of [
    "parse.ts",
    "types.ts",
    "contract.ts",
    "fetch.ts",
    "check.ts",
    "config/contracts.yaml",
    "snapshots.json",
    "last-good.json",
  ])
    locked[f] = hash(readFileSync(join(dir, f), "utf8"));
  return { dir, bin, scraper: join(dir, "scrapers", `${inc.source}.ts`), locked };
}

function incidentText(inc: Incident, visible: Record<string, Page>): string {
  return `# Incident ${inc.id}: ${inc.source} on ${inc.today}

The scraper for this source no longer produces a crawl that passes its contract. The site has most
likely changed its layout. Production data for this source is frozen at the last good crawl until a
repaired scraper is deployed.

## What the contract found

${inc.findings.map((f) => `- ${f.level} \`${f.check}\`${f.ref ? ` (${f.ref})` : ""}: ${f.detail}`).join("\n") || "- nothing (the scraper threw before the contract ran)"}

## Files

- \`scrapers/${inc.source}.ts\`: the scraper. **This is the only file you may change.**
- \`snapshots.json\`: pages the site serves today (${Object.keys(visible).length}), keyed by path.
- \`last-good.json\`: the last crawl that passed the contract. Documents whose version did not change
  must come out exactly the same.
- \`parse.ts\`, \`types.ts\`: helpers and types the scraper may import (do not change).
- \`contract.ts\`, \`config/contracts.yaml\`, \`check.ts\`: the checks (do not change).

Run \`rif-check\` to run the scraper on the snapshots through the contract.
`;
}
