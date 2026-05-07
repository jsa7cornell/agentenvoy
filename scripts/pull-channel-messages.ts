import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const userId = process.argv[2];
  const sinceIso = process.argv[3];
  if (!userId || !sinceIso) {
    console.error("Usage: npx tsx --env-file=.env.local scripts/pull-channel-messages.ts <userId> <sinceIso>");
    process.exit(1);
  }

  const channels = await prisma.channel.findMany({ where: { userId }, select: { id: true } });
  const messages = await prisma.channelMessage.findMany({
    where: {
      channelId: { in: channels.map((c) => c.id) },
      createdAt: { gte: new Date(sinceIso) },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`${messages.length} messages since ${sinceIso}\n`);
  for (const m of messages) {
    console.log(`================================================================`);
    console.log(`[${m.role.toUpperCase()} ${m.id}  ${m.createdAt.toISOString()}]`);
    console.log(`content:\n${m.content.slice(0, 600)}${m.content.length > 600 ? "...[truncated]" : ""}`);
    if (m.metadata && typeof m.metadata === "object") {
      const meta = m.metadata as Record<string, unknown>;
      for (const k of ["actions", "actionResults", "moduleGuard"]) {
        if (k in meta) {
          const val = meta[k];
          const str = JSON.stringify(val, null, 2);
          if (str.length > 1500) {
            console.log(`metadata.${k}: ${str.slice(0, 1500)}...[truncated]`);
          } else {
            console.log(`metadata.${k}: ${str}`);
          }
        }
      }
    }
    console.log("");
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
