const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

const INSTRUMENTS = [
  { symbol: "EURUSD", description: "Euro / US Dollar", digits: 5, pipSize: 0.0001, spreadPips: 1.5 },
  { symbol: "GBPUSD", description: "British Pound / US Dollar", digits: 5, pipSize: 0.0001, spreadPips: 2.0 },
  { symbol: "USDJPY", description: "US Dollar / Japanese Yen", digits: 3, pipSize: 0.01, spreadPips: 1.5 },
  { symbol: "USDCHF", description: "US Dollar / Swiss Franc", digits: 5, pipSize: 0.0001, spreadPips: 1.8 },
  { symbol: "AUDUSD", description: "Australian Dollar / US Dollar", digits: 5, pipSize: 0.0001, spreadPips: 1.8 },
  { symbol: "USDCAD", description: "US Dollar / Canadian Dollar", digits: 5, pipSize: 0.0001, spreadPips: 2.0 },
  { symbol: "NZDUSD", description: "New Zealand Dollar / US Dollar", digits: 5, pipSize: 0.0001, spreadPips: 2.2 },
  { symbol: "EURGBP", description: "Euro / British Pound", digits: 5, pipSize: 0.0001, spreadPips: 2.0 },
  { symbol: "EURJPY", description: "Euro / Japanese Yen", digits: 3, pipSize: 0.01, spreadPips: 2.0 },
  { symbol: "GBPJPY", description: "British Pound / Japanese Yen", digits: 3, pipSize: 0.01, spreadPips: 2.5 },
];

async function nextLogin(tx) {
  const last = await tx.account.findFirst({ orderBy: { login: "desc" }, select: { login: true } });
  return (last?.login ?? 5_000_000) + 1;
}

const demoBalance = () => Number(process.env.DEMO_BALANCE ?? 10000) || 10000;

async function createDefaultAccounts(tx, userId) {
  const demo = await tx.account.create({
    data: { userId, type: "DEMO", login: await nextLogin(tx), balance: demoBalance() },
  });
  await tx.transaction.create({
    data: { accountId: demo.id, type: "DEPOSIT", amount: demo.balance, method: "Demo funds", note: "Initial demo balance" },
  });
  await tx.account.create({ data: { userId, type: "LIVE", login: await nextLogin(tx), balance: 0 } });
}

async function main() {
  for (const [i, inst] of INSTRUMENTS.entries()) {
    await prisma.instrument.upsert({
      where: { symbol: inst.symbol },
      update: {},
      create: {
        symbol: inst.symbol,
        description: inst.description,
        digits: inst.digits,
        pipSize: inst.pipSize,
        spreadPips: inst.spreadPips,
        sort: i,
      },
    });
  }
  console.log(`Seeded ${INSTRUMENTS.length} instruments`);

  const email = process.env.ADMIN_EMAIL?.toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.log("ADMIN_EMAIL / ADMIN_PASSWORD not set, skipping admin user");
    return;
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role !== "ADMIN") await prisma.user.update({ where: { id: existing.id }, data: { role: "ADMIN" } });
    console.log(`Admin ${email} already exists`);
    return;
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { email, name: "Administrator", passwordHash, role: "ADMIN" } });
    await createDefaultAccounts(tx, user.id);
  });
  console.log(`Created admin ${email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
