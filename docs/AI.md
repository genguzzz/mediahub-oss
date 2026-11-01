# AI 助手

A chat assistant in the app (floating orb above the tab bar: tap = chat sheet, hold = talk; slide up cancels, slide left starts a new chat). It recommends from the owner's taste, finds works from vague descriptions, explains plots, reads the library and ingest pipeline, and searches / ingests / subscribes when asked.

## Server (`server/src/ai/`)

- `settings.ts` — API key, endpoint (Anthropic-compatible base URL), model, web search. Environment (`AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_WEB_SEARCH`) is the default; values set from the app (`PUT /v1/ai/settings`) or admin (`PUT /admin/ai/settings`) are stored in `DATA_DIR/ai/settings.json` (mode 600) and win. `""` clears a stored value. The key is never returned, only "set, N chars, last 4".
- `client.ts` — the Anthropic SDK with undici's fetch on an `AI_PROXY` dispatcher. No proxy → the chat answers "not configured"; there is no direct path.
- `chat.ts` — a turn runs detached from the request (10 min cap, 2 at a time). Events are buffered and fanned out as SSE; `/stream` replays the running turn from its start; `/stop` aborts; a question left without an answer (restart) shows as `interrupted` and `retry` re-asks it. Chats: `DATA_DIR/ai/chats/<id>.json` (app messages with steps + the model's own history, last ~40 messages). Preferences: `DATA_DIR/ai/notes.json` (≤ 50, written by the `remember` tool or edited in the app), injected into every system prompt.
- `tools.ts` — each tool calls this server's own `/v1` routes in-process (`app.inject` with the app token), so validation, caching and library lookups are shared; outputs are slimmed (posters as file names, overviews cut). Tiers:
  - read: `search_media`, `media_detail`, `related_media`, `discover`, `tmdb_discover`, `person_works`, `library_search`, `library_latest`, `watch_history` (`/v1/emby/played`), `tasks`, `subscriptions`, `health`, `find_resources`; `catalog_list` / `catalog_item` only when 成人内容 is on (the app sends `adult`).
  - write (ordinary user actions, only when asked): `ingest_resource` (by the short ref `find_resources` gave — the model never handles magnets), `auto_ingest`, `subscribe`, `retry_task`, `refresh_library_item`.
  - memory: `remember`.
  - nothing deletes, cancels, stops services, changes configuration or reads credentials; only the listed routes are reachable.
  - plus the API's `web_search` server tool unless turned off.
- `prompt.ts` — system prompt (English, answers in Chinese). Answers may contain ```` ```media [{type,tmdbid,title,year,poster,why}] ```` blocks (poster cards) and links like `[绝命毒师](/media/tv/1396)`, `/person/<id>`, `/task/<hash>`, `/emby/<id>`, `/tasks`, `/settings`.

SSE events: `chat {chatId}`, `text_start`, `text {delta}`, `think_start`, `think {delta}`, `think_end {ms}`, `tool {id,name,label}`, `tool_input {id,input,label}`, `tool_done {id,ok,output}`, `memory {text,replaces}`, `done {text,latencyMs}`, `error {error}`, `idle`; `: ping` every 15 s.

## App

`src/lib/ai.ts` (state + connection: expo/fetch streaming, 40 s stale watchdog, backoff reconnect, resume on foreground / network), `src/lib/voice.ts` (hold / tap to talk on iOS speech recognition), `src/components/ai/*` (orb, step cards, Markdown, media blocks, history and preference panes), `src/app/ai.tsx` (the sheet), `src/components/AiSettings.tsx` (Settings → AI 助手). The orb passes the page it was opened from (work / person / task / Emby item / adult item) as context.
