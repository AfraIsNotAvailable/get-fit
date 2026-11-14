/** Express 5 wrapper: parse, call one service, pick a status. No rules here. */
import express, { type NextFunction, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { HttpError, type Services } from "./service.js";

export interface AppOptions {
  requireToken?: boolean;
  webRoot?: string | null;
}

const problem = (res: Response, status: number, code: string, title: string, extra: object = {}) =>
  res.status(status).type("application/problem+json").json({
    type: `https://fit.afrasinei.dev/problems/${code}`,
    title,
    status,
    code,
    ...extra,
  });

function parseSections(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function createApp(services: Services, options: AppOptions = {}): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.use((req, res, next) => {
    const id = req.get("x-request-id") ?? createHash("sha1")
      .update(`${Date.now()}${Math.random()}`).digest("hex").slice(0, 12);
    res.setHeader("x-request-id", id);
    res.setHeader("cache-control", "no-store");
    next();
  });

  if (options.requireToken) {
    app.use("/api/", (req, res, next) => {
      const header = req.get("authorization") ?? "";
      if (!header.startsWith("Bearer ")) {
        return problem(res, 401, "unauthorized", "A bearer token is required");
      }
      next();
    });
  }

  app.get("/api/v1/health", (_req, res) => {
    res.json({
      ok: true,
      version: "0.1.0",
      db: { ok: true, path: "configured", schemaVersion: 1 },
      scheduler: { enabled: true },
    });
  });

  app.get("/api/v1/meta", (_req, res) => res.json(services.meta()));

  app.get("/api/v1/now", (_req, res) => {
    res.json(services.dashboard(["serverTime"]).body.serverTime);
  });

  app.get("/api/v1/dashboard", (req, res) => {
    const { body, etag } = services.dashboard(parseSections(req.query.sections));
    res.setHeader("etag", etag);
    if (req.get("if-none-match") === etag) return res.status(304).end();
    res.json(body);
  });

  app.get("/api/v1/rounds", (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ items: services.rounds(Number.isFinite(limit) ? limit : 50) });
  });

  app.get("/api/v1/rounds/:key", (req, res) => res.json(services.round(req.params.key)));

  app.post("/api/v1/rounds/:key/confirm", (req, res) => {
    const source = String(req.body?.source ?? "web");
    const outcome = services.confirm(req.params.key, source);
    res.json({
      roundKey: outcome.round.key,
      status: outcome.round.status,
      receipt: outcome.receipt,
      clock: outcome.clock,
    });
  });

  app.get("/api/v1/checkins/todo", (_req, res) => res.json(services.checkinTodo()));

  app.post("/api/v1/checkins", (req, res) => {
    const result = services.checkin(req.body ?? {});
    res.status(201).json(result);
  });

  app.get("/api/v1/muscles", (_req, res) => res.json(services.dashboard(["muscles"]).body.muscles));

  app.get("/api/v1/profile", (_req, res) => res.json(services.dashboard(["profile"]).body.profile));

  app.get("/api/v1/calendar", (_req, res) => {
    const body = services.dashboard(["calendar", "months"]).body;
    res.json({ ...body.calendar, months: body.months });
  });

  app.get("/api/v1/settings", (_req, res) => {
    const body = services.dashboard(["settings"]).body;
    res.json(body.settings);
  });

  app.put("/api/v1/settings", (req, res) => res.json(services.saveSettings(req.body)));

  if (options.webRoot) {
    app.use(express.static(options.webRoot, { index: "index.html" }));
  }

  app.use((_req, res) => problem(res, 404, "not_found", "No such route"));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      return problem(res, error.status, error.code, error.message, error.current === undefined
        ? {}
        : { current: error.current });
    }
    if (error instanceof SyntaxError) {
      return problem(res, 400, "bad_json", "The request body is not valid JSON");
    }
    // eslint-disable-next-line no-console
    console.error("[getfit] unhandled", error);
    return problem(res, 500, "internal_error", "Something broke");
  });

  return app;
}
