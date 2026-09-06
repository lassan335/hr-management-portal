import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { env } from "./env";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Central error handler — must be the LAST app.use(). Never leaks stack
 * traces, DB connection strings, or internal file paths to the client
 * (Express's default handler does exactly that, which is why this exists).
 * Full detail is logged server-side only.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "validation_error", details: err.flatten() });
  }

  const status = typeof (err as { status?: unknown })?.status === "number"
    ? (err as { status: number }).status
    : 500;

  if (status >= 500) {
    console.error(err);
  }

  const message =
    status < 500
      ? (err as Error)?.message ?? "error"
      : env.isProduction
        ? "internal_server_error"
        : (err as Error)?.message ?? "internal_server_error";

  res.status(status).json({ error: message });
}
