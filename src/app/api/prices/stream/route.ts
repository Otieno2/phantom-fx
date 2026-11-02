import { feedForRequest, feedPayload } from "@/server/feed-context";
import { errorResponse } from "@/lib/http";
import type { Tick } from "@/server/prices";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // The stream is bound to the feed this session resolved, for its whole life.
  // A `?account=` the caller does not own is a 404 here, not a silent demo tape:
  // an EventSource has no body to read, so the honest answer is a failed
  // connection and the JSON routes carry the same reason in text (A-4).
  let selection;
  try {
    selection = await feedForRequest(req);
  } catch (err) {
    return errorResponse(err);
  }
  const feed = selection.feed;
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const write = (frame: string) => {
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          cleanup();
        }
      };
      // Unnamed frames keep the shape the terminal already reads.
      const sendTicks = (ticks: Tick[]) => write(`data: ${JSON.stringify({ ticks, ...feedPayload(feed, selection) })}\n\n`);
      // A named frame carries state transitions between ticks: a paused feed
      // emits no marks, so this is how the banner learns it stopped.
      const sendStatus = () => write(`event: status\ndata: ${JSON.stringify(feedPayload(feed, selection))}\n\n`);
      const ping = setInterval(() => write(": ping\n\n"), 15_000);
      cleanup = () => {
        feed.off("ticks", sendTicks);
        feed.off("status", sendStatus);
        clearInterval(ping);
      };
      // Only this session's feed is subscribed, so a demo tab never receives the
      // live tape and a live tab never receives the steered simulation.
      feed.on("ticks", sendTicks);
      feed.on("status", sendStatus);
      sendTicks(feed.ticks());
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
