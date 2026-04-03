import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TEST_USER_ID = "test-user-e2e";
const TEST_KEY_ID = "test-apikey-e2e";
const TEST_LINK_ID = "test-link-e2e";
// SHA-256 of "ae_test_key_e2e"
const TEST_KEY_HASH =
  "e581b6cfe951066216f67fb401e8ffce6b69a77eb80211b13f0285f4546db17c";

async function main() {
  // 1. Upsert test host user
  const user = await prisma.user.upsert({
    where: { id: TEST_USER_ID },
    update: {
      name: "Test Host",
      email: "testhost@agentenvoy.dev",
      meetSlug: "testhost",
      preferences: {
        preferredTimes: ["morning"],
        format: "phone",
        duration: 30,
      },
      hostDirectives: [
        "Always confirm timezone",
        "Prefer phone calls",
      ],
    },
    create: {
      id: TEST_USER_ID,
      name: "Test Host",
      email: "testhost@agentenvoy.dev",
      meetSlug: "testhost",
      preferences: {
        preferredTimes: ["morning"],
        format: "phone",
        duration: 30,
      },
      hostDirectives: [
        "Always confirm timezone",
        "Prefer phone calls",
      ],
    },
  });
  console.log(`✓ User upserted: ${user.id} (${user.email})`);

  // 2. Upsert API key (hash of "ae_test_key_e2e")
  const apiKey = await prisma.apiKey.upsert({
    where: { id: TEST_KEY_ID },
    update: { key: TEST_KEY_HASH, userId: user.id, name: "E2E Test Key" },
    create: {
      id: TEST_KEY_ID,
      key: TEST_KEY_HASH,
      userId: user.id,
      name: "E2E Test Key",
    },
  });
  console.log(`✓ API key upserted: ${apiKey.id}`);

  // 3. Upsert a contextual NegotiationLink for session persistence tests
  const link = await prisma.negotiationLink.upsert({
    where: { id: TEST_LINK_ID },
    update: {
      userId: user.id,
      type: "contextual",
      slug: "testhost",
      code: "test-ctx-001",
      inviteeEmail: "sarah@example.com",
      inviteeName: "Sarah Chen",
      topic: "Q2 Roadmap Review",
      rules: {
        format: "phone",
        preferredDays: ["tuesday", "wednesday"],
      },
    },
    create: {
      id: TEST_LINK_ID,
      userId: user.id,
      type: "contextual",
      slug: "testhost",
      code: "test-ctx-001",
      inviteeEmail: "sarah@example.com",
      inviteeName: "Sarah Chen",
      topic: "Q2 Roadmap Review",
      rules: {
        format: "phone",
        preferredDays: ["tuesday", "wednesday"],
      },
    },
  });
  console.log(`✓ Contextual link upserted: ${link.id} (code: ${link.code})`);

  // 4. Clean up any stale test sessions from prior runs
  const deleted = await prisma.negotiationSession.deleteMany({
    where: {
      hostId: TEST_USER_ID,
      linkId: TEST_LINK_ID,
    },
  });
  if (deleted.count > 0) {
    console.log(`✓ Cleaned ${deleted.count} stale test session(s)`);
  }

  console.log("\n🌱 Seed complete.\n");
  console.log("Test credentials:");
  console.log("  API key (plaintext): ae_test_key_e2e");
  console.log("  Host slug:           testhost");
  console.log("  Contextual code:     test-ctx-001");
  console.log("  Dev auth email:      testhost@agentenvoy.dev");
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
