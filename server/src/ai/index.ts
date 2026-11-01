// /v1/ai/* (app token) and /admin/ai/settings (admin token). A chat turn answers as Server-Sent Events:
// `data: <json>` per event, `: ping` every 15 s; the run keeps going when the connection drops.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { addNote, attach, deleteNote, getChat, getNotes, listChats, removeChat, startChat, stopChat } from "./chat.ts";
import { status, update } from "./settings.ts";

function sse(reply: FastifyReply, chatId: number, onClose?: () => void) {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no", "access-control-allow-origin": "*" });
  const write = (ev: unknown) => raw.write(`data: ${JSON.stringify(ev)}\n\n`);
  const ping = setInterval(() => raw.write(": ping\n\n"), 15_000);
  let detach: (() => void) | null = null;
  const end = () => {
    clearInterval(ping);
    detach?.();
    if (!raw.writableEnded) raw.end();
    onClose?.();
  };
  detach = attach(chatId, (ev) => {
    write(ev);
    const t = (ev as { type?: string }).type;
    if (t === "done" || t === "error") setImmediate(end);
  });
  if (!detach) {
    write({ type: "idle" });
    end();
  }
  raw.on("close", end);
}

const Settings = z.object({
  apiKey: z.string().max(400).optional(),
  baseUrl: z.string().max(300).optional(),
  model: z.string().max(80).optional(),
  webSearch: z.boolean().nullable().optional(),
});

export function registerAi(app: FastifyInstance) {
  app.get("/v1/ai/settings", async () => status());
  app.put("/v1/ai/settings", async (req) => update(Settings.parse(req.body ?? {})));
  app.get("/admin/ai/settings", async () => status());
  app.put("/admin/ai/settings", async (req) => update(Settings.parse(req.body ?? {})));

  app.post("/v1/ai/chat", async (req, reply) => {
    const b = z.object({
      chatId: z.number().int().min(0).optional(),
      message: z.string().max(4000).default(""),
      retry: z.boolean().default(false),
      voice: z.boolean().default(false),
      model: z.string().max(80).optional(),
      adult: z.boolean().default(false),
      screen: z.string().max(300).optional(),
    }).parse(req.body ?? {});
    const id = await startChat(app, { chatId: b.chatId || undefined, message: b.message, retry: b.retry, voice: b.voice, model: b.model, context: { adult: b.adult, screen: b.screen } });
    sse(reply, id);
  });
  app.get("/v1/ai/chats", async () => listChats());
  app.get<{ Params: { id: string } }>("/v1/ai/chats/:id", async (req) => {
    const c = await getChat(Number(req.params.id));
    if (!c) throw Object.assign(new Error("没有这个对话"), { statusCode: 404 });
    return c;
  });
  app.get<{ Params: { id: string } }>("/v1/ai/chats/:id/stream", async (req, reply) => sse(reply, Number(req.params.id)));
  app.post<{ Params: { id: string } }>("/v1/ai/chats/:id/stop", async (req) => ({ ok: stopChat(Number(req.params.id)) }));
  app.delete<{ Params: { id: string } }>("/v1/ai/chats/:id", async (req) => {
    await removeChat(Number(req.params.id));
    return { ok: true };
  });

  app.get("/v1/ai/notes", async () => getNotes());
  app.post("/v1/ai/notes", async (req) => addNote(z.object({ text: z.string().min(1).max(300) }).parse(req.body).text, "owner"));
  app.delete<{ Params: { id: string } }>("/v1/ai/notes/:id", async (req) => {
    await deleteNote(Number(req.params.id));
    return { ok: true };
  });
}
