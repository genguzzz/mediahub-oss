// All settings come from the environment (systemd EnvironmentFiles on the server:
// an .env file for APP_TOKEN/ADMIN_TOKEN/MP_API_KEY, see server/.env.example).
// Secrets never live in the repo.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8793),
  host: process.env.HOST ?? "127.0.0.1",
  dataDir: process.env.DATA_DIR ?? "./data",
  cacheDir: process.env.CACHE_DIR ?? "./cache",
  // MoviePilot on the same host; the Prowlarr115 plugin's /hub/* routes do everything NAS-side.
  mpUrl: process.env.MP_URL ?? "http://127.0.0.1:3000/api/v1",
  mpKey: required("MP_API_KEY"),
  plugin: process.env.MP_PLUGIN ?? "Prowlarr115",
  // Expo Updates: bundles on disk, assets served by nginx under UPDATES_BASE/assets/.
  updatesDir: process.env.UPDATES_DIR ?? "./updates",
  updatesBase: process.env.UPDATES_BASE ?? "https://media.example.com/updates",
  // Emby account the app logs in with (it then talks to Emby directly, not through here).
  emby: { url: process.env.EMBY_URL ?? "https://emby.example.com:8920", user: process.env.EMBY_USER ?? "", pass: process.env.EMBY_PASS ?? "" },
  appToken: required("APP_TOKEN"),
  adminToken: required("ADMIN_TOKEN"),
};
