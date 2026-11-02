import { json, route } from "@/lib/http";
import { getInstruments } from "@/server/instrumentCache";
import { feedForRequest, feedPayload } from "@/server/feed-context";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  // The feed is chosen from the session and the caller's own account row — never
  // from a feed name, and an unrecognised Account.type throws instead of
  // defaulting to the steered tape.
  const selection = await feedForRequest(req);
  const feed = selection.feed;
  const instruments = [...(await getInstruments()).values()]
    .filter((i) => i.enabled)
    .sort((a, b) => a.sort - b.sort)
    .map(({ symbol, description, digits, pipSize, contractSize, minLot, maxLot, spreadPips, commissionPerLot, base, quote }) => ({
      symbol, description, digits, pipSize, contractSize, minLot, maxLot, spreadPips, commissionPerLot, base, quote,
    }));
  return json({
    instruments,
    ticks: feed.ticks(),
    ...feedPayload(feed, selection),
  });
});
