import { requireOwnAccount, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { HttpError, json, route } from "@/lib/http";
import { demoBalance } from "@/server/accounts";
import { withLock } from "@/server/lock";
import { feedFor } from "@/server/prices";

export const POST = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const account = await requireOwnAccount(user.id, id);
  if (account.type !== "DEMO") throw new HttpError(400, "Only demo accounts can be reset");
  await withLock(id, () =>
    prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.position.updateMany({
        where: { accountId: id, status: "OPEN" },
        data: { status: "CLOSED", closeReason: "ADMIN", profit: 0, closedAt: now },
      });
      await tx.order.updateMany({ where: { accountId: id, status: "PENDING" }, data: { status: "CANCELLED", reason: "Demo reset" } });
      const balance = demoBalance();
      await tx.transaction.create({
        data: { accountId: id, type: "DEMO_RESET", amount: balance - account.balance, note: `Demo account reset to $${balance}` },
      });
      await tx.account.update({ where: { id }, data: { balance } });
    }),
  );
  // Only demo positions are ever registered for steering.
  feedFor("DEMO").clearAccount(id);
  return json({ ok: true });
});
