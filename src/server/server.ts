import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type {
  AgendaEvent,
  AgendaState,
  ClientMessage,
  ServerMessage,
  Speaker,
} from "../shared/types.js";
import { seedState } from "./seed.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data", "state.json");
const PORT = Number(process.env.PORT ?? 3000);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---------- persistência ----------

async function loadState(): Promise<AgendaState> {
  if (existsSync(DATA_FILE)) {
    try {
      const parsed = JSON.parse(await readFile(DATA_FILE, "utf8")) as Partial<AgendaState>;
      return {
        events: parsed.events ?? [],
        votes: parsed.votes ?? {},
        reserved: parsed.reserved ?? {},
      };
    } catch (err) {
      console.error("state.json inválido, usando dados iniciais:", err);
    }
  }
  return seedState();
}

let state: AgendaState = await loadState();
let saveTimer: NodeJS.Timeout | undefined;

function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveNow().catch((err) => console.error("Falha ao salvar:", err));
  }, 200);
}

async function saveNow(): Promise<void> {
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, DATA_FILE);
}

// ---------- validação ----------

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function textList(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value.map((v) => text(v, max)).filter((v) => v.length > 0)
    : [];
}

function sanitizeEvent(input: unknown, id: string): AgendaEvent | null {
  if (!input || typeof input !== "object") return null;
  const e = input as Record<string, unknown>;
  const date = text(e.date, 10);
  const start = text(e.start, 5);
  const end = text(e.end, 5);
  const title = text(e.title, 200);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  // horário é opcional: ao importar pelo link ele fica "a definir"
  if (start && !/^\d{2}:\d{2}$/.test(start)) return null;
  if (end && !/^\d{2}:\d{2}$/.test(end)) return null;
  if (!title) return null;

  const speakers: Speaker[] = Array.isArray(e.speakers)
    ? e.speakers
        .map((s): Speaker | null => {
          if (typeof s === "string") return text(s, 120) ? { name: text(s, 120) } : null;
          if (s && typeof s === "object") {
            const o = s as Record<string, unknown>;
            const name = text(o.name, 120);
            const role = text(o.role, 120);
            return name ? (role ? { name, role } : { name }) : null;
          }
          return null;
        })
        .filter((s): s is Speaker => s !== null)
    : [];

  return {
    id,
    date,
    start,
    end,
    title,
    description: text(e.description, 2000),
    format: text(e.format, 80),
    audience: text(e.audience, 120),
    access: text(e.access, 120),
    organizer: text(e.organizer, 120),
    speakers,
    location: text(e.location, 160),
    address: text(e.address, 240),
    tags: textList(e.tags, 80),
    link: parseShareLink(text(e.link, 300))?.link ?? "",
    image: isStaticImage(text(e.image, 300)) ? text(e.image, 300) : "",
  };
}

const VOTER_RE = /^[A-Za-z0-9-]{8,64}$/;

// ---------- link oficial (share.jalanlive.com) ----------

const SHARE_HOST = "share.jalanlive.com";
const SHARE_PATH = "/recnplay2026";
const ACTIVITY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Aceita só links https do site oficial com activityID e devolve o link canônico. */
function parseShareLink(raw: string): { id: string; link: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== SHARE_HOST || url.pathname !== SHARE_PATH) {
    return null;
  }
  const id = url.searchParams.get("activityID") ?? "";
  if (!ACTIVITY_RE.test(id)) return null;
  return { id, link: `https://${SHARE_HOST}${SHARE_PATH}?activityID=${id}` };
}

function isStaticImage(url: string): boolean {
  return url.startsWith("https://static.jalanlive.com/");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function metaContent(html: string, property: string): string {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (tag.includes(`property="${property}"`)) {
      const content = /content="([^"]*)"/.exec(tag);
      if (content) return decodeEntities(content[1]!);
    }
  }
  return "";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** GET /api/import?url=... -> lê título e imagem do link oficial */
async function handleImport(res: ServerResponse, reqUrl: URL): Promise<void> {
  const parsed = parseShareLink(reqUrl.searchParams.get("url") ?? "");
  if (!parsed) {
    return sendJson(res, 400, {
      error: "Link inválido. Use o link do evento no site oficial (share.jalanlive.com).",
    });
  }
  try {
    const upstream = await fetch(parsed.link, {
      headers: { "User-Agent": "AgendaRec/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    const html = (await upstream.text()).slice(0, 200_000);
    const title = metaContent(html, "og:title");
    if (!title) throw new Error("sem título");
    const image = metaContent(html, "og:image");
    return sendJson(res, 200, {
      id: parsed.id,
      link: parsed.link,
      title,
      image: isStaticImage(image) ? image : "",
    });
  } catch (err) {
    console.error("Falha ao importar link:", err);
    return sendJson(res, 502, {
      error: "Não consegui ler o link oficial agora. Preencha os dados manualmente.",
    });
  }
}

// ---------- votação ----------

/** Um voto por navegador por dia. Não há como desfazer. */
function votedOnDay(voter: string, day: string): boolean {
  return state.events.some(
    (e) => e.date === day && (state.votes[e.id] ?? []).includes(voter),
  );
}

/** Data de hoje no fuso de Recife (AGENDA_TODAY sobrescreve, usado em testes). */
function todayInRecife(): string {
  if (process.env.AGENDA_TODAY) return process.env.AGENDA_TODAY;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Recife",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** A votação de um dia termina quando chega a data do evento. */
function dayArrived(day: string): boolean {
  return day <= todayInRecife();
}

/** Ao chegar a data, o único mais votado do dia vai para Reservados. Empate não reserva. */
function settleDueDays(): boolean {
  let changed = false;
  const days = new Set(state.events.map((e) => e.date));
  for (const day of days) {
    if (!dayArrived(day)) continue;
    const hasWinner = state.events.some((e) => e.date === day && state.reserved[e.id]);
    if (hasWinner) continue;

    const counts = state.events
      .filter((e) => e.date === day)
      .map((e) => ({ id: e.id, n: (state.votes[e.id] ?? []).length }))
      .sort((a, b) => b.n - a.n);
    const top = counts[0];
    if (!top || top.n === 0) continue;
    if (counts[1] && counts[1].n === top.n) continue;

    state.reserved[top.id] = "votacao";
    changed = true;
  }
  return changed;
}

// ---------- WebSocket ----------

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Erro para quem enviou + estado atual, para o cliente desfazer mudanças otimistas. */
function sendError(ws: WebSocket, message: string): void {
  send(ws, { type: "error", message });
  send(ws, { type: "state", state });
}

function broadcastState(): void {
  const msg: ServerMessage = { type: "state", state };
  for (const client of wss.clients) send(client, msg);
}

function handleMessage(ws: WebSocket, raw: string): void {
  if (settleDueDays()) scheduleSave();
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    return sendError(ws, "Mensagem inválida.");
  }

  switch (msg.type) {
    case "vote": {
      const ev = state.events.find((e) => e.id === msg.eventId);
      const voter = text(msg.voterId, 64);
      if (!ev || !VOTER_RE.test(voter)) return sendError(ws, "Não foi possível registrar o voto.");
      if (state.reserved[ev.id]) return sendError(ws, "Este evento já está reservado.");
      if (dayArrived(ev.date)) return sendError(ws, "A votação deste dia já terminou.");
      if (votedOnDay(voter, ev.date)) return sendError(ws, "Você já votou neste dia.");
      state.votes[ev.id] = [...(state.votes[ev.id] ?? []), voter];
      break;
    }

    case "addEvent": {
      const share = parseShareLink(text((msg.event as { link?: unknown })?.link, 300));
      const id = share?.id ?? randomUUID().slice(0, 8);
      if (share && state.events.some((ev) => ev.link === share.link)) {
        return sendError(ws, "Esse evento já está na agenda.");
      }
      const event = sanitizeEvent(msg.event, id);
      if (!event) return sendError(ws, "Dados do evento inválidos.");
      state.events.push(event);
      break;
    }

    case "updateEvent": {
      const ev = state.events.find((e) => e.id === msg.eventId);
      const next = ev ? sanitizeEvent({ ...ev, date: msg.date, start: msg.start, end: msg.end }, ev.id) : null;
      if (!ev || !next) return sendError(ws, "Não foi possível salvar o horário.");
      // trocar o dia depois de haver votos mudaria a votação de outro dia
      const changesDay = next.date !== ev.date;
      if (changesDay && ((state.votes[ev.id] ?? []).length > 0 || state.reserved[ev.id])) {
        return sendError(ws, "Não dá para mudar o dia de um evento que já recebeu votos.");
      }
      if (dayArrived(next.date) && next.date !== ev.date) {
        return sendError(ws, "Não dá para mudar para um dia que já chegou.");
      }
      Object.assign(ev, { date: next.date, start: next.start, end: next.end });
      break;
    }

    default:
      return sendError(ws, "Ação desconhecida.");
  }

  scheduleSave();
  broadcastState();
}

// ---------- HTTP (arquivos estáticos) ----------

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const urlPath = new URL(req.url ?? "/", "http://localhost").pathname;
    const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
    const filePath = path.normalize(path.join(PUBLIC_DIR, rel));

    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Não encontrado");
  }
}

// ---------- inicialização ----------

const httpServer = createServer((req, res) => {
  const reqUrl = new URL(req.url ?? "/", "http://localhost");
  if (reqUrl.pathname === "/api/import") {
    void handleImport(res, reqUrl);
    return;
  }
  void serveStatic(req, res);
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws) => {
  send(ws, { type: "state", state });
  ws.on("message", (data) => handleMessage(ws, data.toString()));
});

// confere os vencedores a cada minuto, mesmo sem ninguém conectado
setInterval(() => {
  if (settleDueDays()) {
    scheduleSave();
    broadcastState();
  }
}, 60_000);

httpServer.listen(PORT, () => {
  if (settleDueDays()) scheduleSave();
  console.log(`Agenda rodando em http://localhost:${PORT}`);
});
