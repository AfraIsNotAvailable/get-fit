/** Config: env in, typed object out. Nothing else reads process.env. */
export interface Config {
  dbPath: string;
  host: string;
  port: number;
  scheduler: boolean;
  dev: boolean;
  requireToken: boolean;
  webRoot: string | null;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "off", "false", "no"].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    dbPath: env.GETFIT_DB ?? "/home/afra/get-fit/getfit.db",
    host: env.GETFIT_HOST ?? "127.0.0.1",
    port: Number(env.GETFIT_PORT ?? 8787),
    scheduler: flag(env.SCHEDULER, true),
    dev: flag(env.GETFIT_DEV, false),
    requireToken: flag(env.GETFIT_REQUIRE_TOKEN, false),
    webRoot: env.GETFIT_WEB ?? null,
  };
}
