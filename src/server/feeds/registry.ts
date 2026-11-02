import { prisma } from "@/lib/db";
import { feedPlan, type FeedConfig, type FeedPlan } from "./config";
import {
  asAccountType,
  roleFor,
  servedType,
  type AccountType,
  type FeedRole,
  type FeedStatus,
} from "./types";
import { DemoFeed, LiveFeed, type Feed, type FeedOverrides } from "./feed";

/**
 * The selection API: two independently running feeds, chosen by the account
 * type of whoever is asking — never by a client-supplied feed name. There are
 * always two slots; a shared tape is the bug this module exists to remove.
 *
 * The types carry the same rule: `demo` is a `DemoFeed` with the steering
 * surface, `live` is a `LiveFeed` without one (design A-1).
 */
export interface FeedRegistry {
  readonly demo: DemoFeed;
  readonly live: LiveFeed;
  /** The feed whose marks belong to `accountType`, narrowed by the literal (A-1). */
  for(accountType: "DEMO"): DemoFeed;
  for(accountType: "LIVE"): LiveFeed;
  /** An account type you cannot prove is one of the two answers with the shared surface. */
  for(accountType: AccountType): Feed;
  /** Which slot the public/anonymous ticker reads (`PUBLIC_FEED`, default live). */
  readonly publicRole: FeedRole;
  /** Always two distinct instances. */
  instances(): Feed[];
  /** Anything the environment got wrong, for the startup log. */
  readonly warnings: string[];
  start(): void;
  stop(): void;
}

function assertType(accountType: AccountType, context: string): AccountType {
  return asAccountType(accountType, context);
}

export function createRegistry(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<Record<AccountType, FeedOverrides>> = {},
): FeedRegistry {
  const plan: FeedPlan = feedPlan(env);
  // The class follows the config, so a steering surface cannot exist on the live
  // slot even if a caller asked for the wrong one (A-1).
  if (plan.demo.steering.allowed !== (plan.demo.purpose === "DEMO")) {
    throw new Error("registry: only the demo slot may be steerable");
  }
  const demo = new DemoFeed(plan.demo, overrides.DEMO);
  const live = new LiveFeed(plan.live, overrides.LIVE);
  if ((demo as unknown) === (live as unknown)) throw new Error("registry: demo and live must never be the same instance");

  const byRole: Record<FeedRole, Feed> = { demo, live };
  const instances = (): Feed[] => [demo, live];
  const select = (accountType: AccountType): Feed => byRole[roleFor(assertType(accountType, "feed selection"))];

  return {
    demo,
    live,
    publicRole: plan.publicRole,
    warnings: plan.warnings,
    for: select as FeedRegistry["for"],
    instances,
    start: () => instances().forEach((feed) => feed.start()),
    stop: () => instances().forEach((feed) => feed.stop()),
  };
}

/**
 * Everything that can change which feeds exist or how they behave (A-8). This is
 * deliberately the resolved plan and not a hand-kept list of variable names: a
 * list drifts the moment `feedPlan` reads one more switch (it used to hash
 * `PRICE_FEED_ON_FAILURE`, which selects nothing, and to ignore
 * `TD_DAILY_CREDIT_BUDGET`, which refuses a whole slot). The one input a plan
 * cannot show is the key's *content* — a different key is the same plan, so the
 * presence is hashed too and never the secret itself.
 */
function envSignature(env: Record<string, string | undefined>): string {
  const plan = feedPlan(env);
  const slot = (c: FeedConfig) =>
    [
      c.key,
      c.mode,
      c.purpose,
      c.steering.allowed,
      c.steering.winRate,
      c.onFailure,
      c.allowSimulated,
      c.failureThreshold,
      c.staleMs,
      c.pauseMs,
      c.marketStaleMs,
      c.marketPauseMs,
      c.pollMs,
      c.enforceMarketHours,
      c.illegal,
      c.capped,
    ].join(",");
  return [slot(plan.demo), slot(plan.live), plan.publicRole, plan.warnings.join("|"), env.TWELVE_DATA_API_KEY ? "td-key" : "no-td-key"].join(";");
}

const g = globalThis as unknown as { __feedRegistry?: { signature: string; registry: FeedRegistry } };

/** Survives Next's module reloads in dev so only one pair of tapes ever runs. */
export function feeds(env: Record<string, string | undefined> = process.env): FeedRegistry {
  const signature = envSignature(env);
  const cached = g.__feedRegistry;
  if (cached && cached.signature === signature) return cached.registry;
  if (cached) {
    cached.registry.stop();
    console.log("[prices] feed configuration changed, rebuilding feeds");
  }
  const registry = createRegistry(env);
  g.__feedRegistry = { signature, registry };
  return registry;
}

/**
 * The selection call server paths use. The account type is required and is
 * never guessed: an unknown value throws instead of defaulting to the steered
 * tape (R10, R12). A literal type narrows the answer, so steering is reachable
 * from a demo selection and unreachable from a live one (A-1).
 */
export function feedFor(accountType: "DEMO"): DemoFeed;
export function feedFor(accountType: "LIVE"): LiveFeed;
export function feedFor(accountType: AccountType): Feed;
export function feedFor(accountType: AccountType): Feed {
  return feeds().for(accountType);
}

export function demoFeed(): DemoFeed {
  return feeds().demo;
}

export function liveFeed(): LiveFeed {
  return feeds().live;
}

/**
 * The pre-login / marketing ticker. `PUBLIC_FEED` chooses the slot (default:
 * live, because a public ticker should advertise real prices). When that slot
 * has no trustworthy marks the other one answers and the payload says so — an
 * honest "Simulated prices" label beats a blank ticker, an unlabelled one does
 * not (design §3.4).
 */
export function publicFeed(): Feed {
  const registry = feeds();
  const preferred = registry.for(servedType(registry.publicRole));
  if (preferred.state() === "running") return preferred;
  const other = registry.for(servedType(registry.publicRole === "live" ? "demo" : "live"));
  return other.state() === "running" ? other : preferred;
}

/** Source of truth is the database row, never a client-supplied type. */
export async function feedForAccount(accountId: string): Promise<Feed> {
  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { type: true } });
  if (!account) throw new Error(`Account ${accountId} does not exist`);
  return feedFor(asAccountType(account.type, `account ${accountId}`));
}

export function startFeeds(): FeedRegistry {
  const registry = feeds();
  registry.start();
  return registry;
}

export function stopFeeds(): void {
  feeds().stop();
}

export function feedStatuses(): FeedStatus[] {
  return feeds().instances().map((feed) => feed.status());
}
