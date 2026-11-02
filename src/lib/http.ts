import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { FeedError } from "@/server/feeds/types";

export class HttpError extends Error {
  /**
   * Extra fields to put in the refusal body — a `code` and a `source`, say, so a
   * client can tell *why* it was refused without parsing the message.
   */
  constructor(
    public status: number,
    message: string,
    readonly payload: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function json<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  return schema.parse(raw);
}

/**
 * The refusal a thrown error answers with. Exported because the SSE endpoint
 * cannot be wrapped in `route()` — it returns a stream, not a Response it can
 * build afterwards — and a failed feed selection there must still be an honest
 * 4xx instead of an unhandled rejection (A-4).
 */
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.message, ...err.payload }, { status: err.status });
  // A feed that cannot price this trade answers with its own code and status:
  // 503 while marks are untrustworthy, 400 when the install is illegal. The
  // client uses `code` to choose between "try again" and "config is wrong".
  if (err instanceof FeedError) return json({ error: err.message, code: err.code }, { status: err.status });
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const field = issue?.path?.join(".");
    return json({ error: field ? `${field}: ${issue.message}` : issue?.message ?? "Invalid input" }, { status: 400 });
  }
  console.error(err);
  return json({ error: "Internal server error" }, { status: 500 });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function route<A extends any[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

const buckets = new Map<string, { count: number; reset: number }>();

export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return;
  }
  b.count += 1;
  if (b.count > limit) throw new HttpError(429, "Too many attempts, please try again later");
}

export function clientIp(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}
