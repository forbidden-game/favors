import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Store } from "./db.js";
import { extractContent } from "./extract.js";
import { buildItem } from "./markdown.js";
import { assetDir, dataDir, itemDir, webDistDir } from "./paths.js";
import type { SaveRequest, SourceType } from "./types.js";

const port = Number(process.env.PORT ?? 8123);
const host = process.env.HOST ?? "127.0.0.1";

mkdirSync(itemDir, { recursive: true });
mkdirSync(assetDir, { recursive: true });

const store = new Store(dataDir);
const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
});

app.get("/api/health", async () => ({
  ok: true,
  dataDir,
  webDistDir,
}));

app.get("/api/stats", async () => store.stats());

app.get("/api/items", async (request) => {
  const query = request.query as { q?: string; type?: SourceType | "all"; limit?: string };
  return store.list({
    q: query.q,
    type: query.type,
    limit: query.limit ? Number(query.limit) : undefined,
  });
});

app.get("/api/items/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const item = store.get(id);
  if (!item) return reply.code(404).send({ error: "Item not found" });

  const markdown = existsSync(item.markdown_path) ? readFileSync(item.markdown_path, "utf8") : "";
  return { ...item, markdown };
});

app.post("/api/save", async (request, reply) => {
  const input = request.body as SaveRequest;
  if (!input?.url) return reply.code(400).send({ error: "Missing url" });

  try {
    new URL(input.url);
  } catch {
    return reply.code(400).send({ error: "Invalid url" });
  }

  const extracted = await extractContent(input);
  const item = buildItem(input, extracted, itemDir);
  store.upsert(item);

  return reply.code(201).send({ ok: true, item });
});

if (existsSync(webDistDir)) {
  await app.register(fastifyStatic, {
    root: webDistDir,
    prefix: "/",
  });
}

app.setNotFoundHandler((request, reply) => {
  const indexPath = path.join(webDistDir, "index.html");
  if (request.method === "GET" && !request.url.startsWith("/api/") && existsSync(indexPath)) {
    return reply.type("text/html").send(createReadStream(indexPath));
  }

  return reply.code(404).send({ error: "Not found" });
});

await app.listen({ port, host });
