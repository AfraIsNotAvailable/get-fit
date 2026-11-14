/** Express 5 wrapper: parse (contracts), call one service, pick a status. */
import express, { type NextFunction, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import {
  CheckinInput, ConfirmationInput, PairInput, SettingsInput, ValidationError, parseOrThrow,
} from "@getfit/contracts";
import type { Device } from "@getfit/db";
import type { CheckinKind } from "@getfit/engine";
import type { AuthService } from "./auth.js";
import { HttpError, type CheckinBody, type Services } from "./service.js";

export interface AppOptions {
  requireToken?: boolean;
  webRoot?: string | null;
  schedulerEnabled?: boolean;
}

const problem = (
  res: Response, status: number, code: string, title: string,
  extra: Record<string, unknown> = {},
) =>
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

export function createApp(services: Services, auth: AuthService, options: AppOptions = {}): express.Express {
  const app = express();
  const requireToken = options.requireToken ?? true;
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.use((req, res, next) => {
    const id = req.get("x-request-id") ?? createHash("sha1")
      .update(`${Date.now()}${Math.random()}`).digest("hex").slice(0, 12);
    res.setHeader("x-request-id", id);
    res.setHeader("cache-control", "no-store");
    next();
  });

  const deviceOf = (res: Response): Device => res.locals.device as Device;

  const requireDevice = (req: Request, res: Response, next: NextFunction) => {
    if (!requireToken) {
      res.locals.device = { deviceId: "local", tokenId: "local", name: "local", platform: "cli" } as Device;
      return next();
    }
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const device = token ? auth.verify(token) : null;
    if (!device) return problem(res, 401, "unauthorized", "A valid bearer token is required");
    res.locals.device = device;
    next();
  };

  // ------------------------------------------------------------- public

  app.get("/api/v1/health", (_req, res) => {
    res.json({
      ok: true,
      version: "0.1.0",
      db: { ok: true, schemaVersion: 2, readOnly: services.isReadOnly },
      scheduler: { enabled: options.schedulerEnabled ?? !services.isReadOnly },
    });
  });

  app.get("/api/v1/meta", (_req, res) => res.json(services.meta()));

  app.post("/api/v1/auth/pair", (req, res) => {
    const body = parseOrThrow(PairInput, req.body ?? {});
    const issued = auth.pair(body);
    if (!issued) {
      return problem(res, 401, "pairing_failed", "that code is unknown, expired or already used");
    }
    return res.status(201).json({
      deviceId: issued.deviceId,
      token: issued.token,
      name: issued.name,
      expiresAt: issued.expiresAt,
    });
  });

  // ------------------------------------------------------------- authenticated

  app.use("/api/v1", (req, res, next) => {
    if (req.path === "/health" || req.path === "/meta" || req.path === "/auth/pair") return next();
    return requireDevice(req, res, next);
  });

  app.get("/api/v1/auth/me", (_req, res) => res.json(deviceOf(res)));

  app.delete("/api/v1/auth/me", (_req, res) => {
    auth.revoke(deviceOf(res));
    res.status(204).end();
  });

  app.get("/api/v1/now", (_req, res) => res.json(services.dashboard(["serverTime"]).body.serverTime));

  app.get("/api/v1/dashboard", (req, res) => {
    const { body, etag } = services.dashboard(parseSections(req.query.sections));
    res.setHeader("etag", etag);
    if (req.get("if-none-match") === etag) return res.status(304).end();
    return res.json(body);
  });

  app.get("/api/v1/rounds", (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ items: services.rounds(Number.isFinite(limit) ? limit : 50) });
  });

  app.get("/api/v1/rounds/:key", (req, res) => res.json(services.round(req.params.key)));

  app.post("/api/v1/rounds/:key/confirm", (req, res) => {
    const body = parseOrThrow(ConfirmationInput, req.body ?? {});
    const outcome = services.confirm(req.params.key, body.source);
    res.json({
      roundKey: outcome.round.key,
      status: outcome.round.status,
      receipt: outcome.receipt,
      clock: outcome.clock,
    });
  });

  app.get("/api/v1/checkins/todo", (_req, res) => res.json(services.checkinTodo()));

  app.get("/api/v1/checkins", (req, res) => {
    const kind = typeof req.query.kind === "string" ? (req.query.kind as CheckinKind) : undefined;
    if (kind && kind !== "gate" && kind !== "post") {
      throw new ValidationError([{ path: "kind", message: "kind must be gate or post" }]);
    }
    const limit = Number(req.query.limit ?? 50);
    res.json(services.checkins({
      kind,
      from: typeof req.query.from === "string" ? req.query.from : undefined,
      to: typeof req.query.to === "string" ? req.query.to : undefined,
      limit: Number.isFinite(limit) ? limit : 50,
    }));
  });

  app.post("/api/v1/checkins", (req, res) => {
    const body = parseOrThrow(CheckinInput, req.body ?? {});
    res.status(201).json(services.checkin(body as CheckinBody));
  });

  app.get("/api/v1/muscles", (_req, res) => res.json(services.dashboard(["muscles"]).body.muscles));
  app.get("/api/v1/muscles/:slug", (req, res) => res.json(services.muscleDetail(req.params.slug)));
  app.get("/api/v1/library", (_req, res) => res.json(services.library()));
  app.get("/api/v1/profile", (_req, res) => res.json(services.dashboard(["profile"]).body.profile));

  app.get("/api/v1/profile/history", (req, res) => {
    const limit = Number(req.query.limit ?? 40);
    res.json(services.profileHistory(Number.isFinite(limit) ? limit : 40));
  });

  app.post("/api/v1/profile/refit", (_req, res) => res.json(services.refit()));

  app.get("/api/v1/calendar", (_req, res) => {
    const body = services.dashboard(["calendar", "months"]).body;
    res.json({ ...body.calendar, months: body.months });
  });

  app.get("/api/v1/settings", (_req, res) => res.json(services.dashboard(["settings"]).body.settings));

  app.put("/api/v1/settings", (req, res) => {
    const body = parseOrThrow(SettingsInput, req.body ?? {});
    res.json(services.saveSettings({
      timezone: body.timezone,
      intervalMinutes: body.intervalMinutes,
      responseMinutes: body.responseMinutes,
      quietStart: body.quietStart,
      quietEnd: body.quietEnd,
      exercises: body.exercises.map((exercise) => ({
        id: exercise.id ?? null,
        name: exercise.name,
        min: exercise.min,
        max: exercise.max ?? null,
        formUrl: exercise.formUrl || null,
      })),
    }));
  });

  if (options.webRoot) app.use(express.static(options.webRoot, { index: "index.html" }));

  app.use((_req, res) => problem(res, 404, "not_found", "No such route"));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ValidationError) {
      return problem(res, 422, "validation_failed", error.message, { errors: error.issues });
    }
    if (error instanceof HttpError) {
      return problem(res, error.status, error.code, error.message,
        error.current === undefined ? {} : { current: error.current });
    }
    if (error instanceof SyntaxError) {
      return problem(res, 400, "bad_json", "The request body is not valid JSON");
    }
    console.error("[getfit] unhandled", error);
    return problem(res, 500, "internal_error", "Something broke");
  });

  return app;
}
