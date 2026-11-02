import { json, route } from "@/lib/http";
import { feedForRequest, feedPayload } from "@/server/feed-context";
import { getCandles } from "@/server/prices";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol") ?? "EURUSD";
  const tf = url.searchParams.get("tf") ?? "1m";
  // Candles come from the same feed that prices this session's marks.
  const selection = await feedForRequest(req);
  return json({
    candles: await getCandles(selection.feed, symbol, tf),
    ...feedPayload(selection.feed, selection),
  });
});
