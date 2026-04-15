import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseActions, stripActionBlocks, executeActions } from "@/agent/actions";

// ─── Parser Tests ────────────────────────────────────────────────────────────

describe("parseActions", () => {
  it("parses a single action block", () => {
    const text =
      'I\'ll archive that now. [ACTION]{"action":"archive","params":{"sessionId":"abc123"}}[/ACTION]';
    const actions = parseActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("archive");
    expect(actions[0].params).toEqual({ sessionId: "abc123" });
  });

  it("parses multiple action blocks", () => {
    const text = [
      "Archiving both sessions.",
      '[ACTION]{"action":"archive","params":{"sessionId":"sess1"}}[/ACTION]',
      '[ACTION]{"action":"archive","params":{"sessionId":"sess2"}}[/ACTION]',
    ].join(" ");
    const actions = parseActions(text);
    expect(actions).toHaveLength(2);
    expect(actions[0].params.sessionId).toBe("sess1");
    expect(actions[1].params.sessionId).toBe("sess2");
  });

  it("parses archive_bulk action", () => {
    const text =
      'Archiving all unconfirmed. [ACTION]{"action":"archive_bulk","params":{"filter":"unconfirmed"}}[/ACTION]';
    const actions = parseActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("archive_bulk");
    expect(actions[0].params.filter).toBe("unconfirmed");
  });

  it("parses cancel action with reason", () => {
    const text =
      'Cancelling now. [ACTION]{"action":"cancel","params":{"sessionId":"x","reason":"Guest requested"}}[/ACTION]';
    const actions = parseActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("cancel");
    expect(actions[0].params.reason).toBe("Guest requested");
  });

  it("parses update_format action", () => {
    const text =
      'Switching to video. [ACTION]{"action":"update_format","params":{"sessionId":"x","format":"video"}}[/ACTION]';
    const actions = parseActions(text);
    expect(actions[0].action).toBe("update_format");
    expect(actions[0].params.format).toBe("video");
  });

  it("parses update_time action with timezone", () => {
    const text =
      'Proposing new time. [ACTION]{"action":"update_time","params":{"sessionId":"x","dateTime":"2026-04-10T14:00:00-07:00","timezone":"America/Los_Angeles"}}[/ACTION]';
    const actions = parseActions(text);
    expect(actions[0].action).toBe("update_time");
    expect(actions[0].params.dateTime).toBe("2026-04-10T14:00:00-07:00");
    expect(actions[0].params.timezone).toBe("America/Los_Angeles");
  });

  it("parses update_location action", () => {
    const text =
      'Updated. [ACTION]{"action":"update_location","params":{"sessionId":"x","location":"123 Main St"}}[/ACTION]';
    const actions = parseActions(text);
    expect(actions[0].params.location).toBe("123 Main St");
  });

  it("parses create_link action", () => {
    const text =
      'Creating link. [ACTION]{"action":"create_link","params":{"inviteeName":"Sarah","topic":"Q3 Planning","format":"video","duration":45}}[/ACTION]';
    const actions = parseActions(text);
    expect(actions[0].action).toBe("create_link");
    expect(actions[0].params.inviteeName).toBe("Sarah");
    expect(actions[0].params.topic).toBe("Q3 Planning");
    expect(actions[0].params.duration).toBe(45);
  });

  it("parses unarchive action", () => {
    const text =
      'Restoring. [ACTION]{"action":"unarchive","params":{"sessionId":"abc"}}[/ACTION]';
    const actions = parseActions(text);
    expect(actions[0].action).toBe("unarchive");
  });

  it("returns empty array for text with no action blocks", () => {
    const text = "Sure, I'll take a look at your schedule and get back to you.";
    expect(parseActions(text)).toHaveLength(0);
  });

  it("returns empty array for empty string", () => {
    expect(parseActions("")).toHaveLength(0);
  });

  it("skips malformed JSON inside action blocks", () => {
    const text = "Oops. [ACTION]{bad json}[/ACTION]";
    const actions = parseActions(text);
    expect(actions).toHaveLength(0);
  });

  it("skips action blocks missing the action field", () => {
    const text = '[ACTION]{"params":{"sessionId":"x"}}[/ACTION]';
    const actions = parseActions(text);
    expect(actions).toHaveLength(0);
  });

  it("skips action blocks where action is not a string", () => {
    const text = '[ACTION]{"action":123,"params":{}}[/ACTION]';
    const actions = parseActions(text);
    expect(actions).toHaveLength(0);
  });

  it("defaults params to empty object if missing", () => {
    const text = '[ACTION]{"action":"archive_bulk"}[/ACTION]';
    const actions = parseActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].params).toEqual({});
  });

  it("parses action blocks with surrounding whitespace", () => {
    const text = "Done.\n\n [ACTION]{\"action\":\"archive\",\"params\":{\"sessionId\":\"x\"}}[/ACTION] \n";
    const actions = parseActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("archive");
  });

  it("parses mixed valid and invalid blocks, keeping valid ones", () => {
    const text = [
      '[ACTION]{"action":"archive","params":{"sessionId":"good"}}[/ACTION]',
      "[ACTION]{broken}[/ACTION]",
      '[ACTION]{"action":"cancel","params":{"sessionId":"also-good"}}[/ACTION]',
    ].join(" ");
    const actions = parseActions(text);
    expect(actions).toHaveLength(2);
    expect(actions[0].action).toBe("archive");
    expect(actions[1].action).toBe("cancel");
  });

  it("does not match partial delimiters", () => {
    const text = '[ACTION]{"action":"archive","params":{}} but no closing tag';
    const actions = parseActions(text);
    expect(actions).toHaveLength(0);
  });

  it("does not match nested delimiters", () => {
    const text = '[ACTION][ACTION]{"action":"archive","params":{}}[/ACTION][/ACTION]';
    const actions = parseActions(text);
    // The inner [ACTION] becomes part of the JSON string, which is invalid JSON — no actions parsed
    expect(actions).toHaveLength(0);
  });

  it("handles special characters in params", () => {
    const text =
      '[ACTION]{"action":"update_location","params":{"sessionId":"x","location":"Café Résumé — 3rd & Main"}}[/ACTION]';
    const actions = parseActions(text);
    expect(actions[0].params.location).toBe("Café Résumé — 3rd & Main");
  });

  it("handles unicode in invitee names", () => {
    const text =
      '[ACTION]{"action":"create_link","params":{"inviteeName":"田中太郎","topic":"打ち合わせ"}}[/ACTION]';
    const actions = parseActions(text);
    expect(actions[0].params.inviteeName).toBe("田中太郎");
  });
});

// ─── Stripper Tests ──────────────────────────────────────────────────────────

describe("stripActionBlocks", () => {
  it("strips a single action block", () => {
    const text =
      'I\'ll archive that now. [ACTION]{"action":"archive","params":{"sessionId":"abc"}}[/ACTION]';
    expect(stripActionBlocks(text)).toBe("I'll archive that now.");
  });

  it("strips multiple action blocks", () => {
    const text =
      'Done! [ACTION]{"action":"archive","params":{"sessionId":"a"}}[/ACTION] Extra text. [ACTION]{"action":"cancel","params":{"sessionId":"b"}}[/ACTION]';
    const result = stripActionBlocks(text);
    expect(result).toContain("Done!");
    expect(result).toContain("Extra text.");
    expect(result).not.toContain("[ACTION]");
    expect(result).not.toContain("[/ACTION]");
  });

  it("returns text unchanged when no action blocks present", () => {
    const text = "No actions here, just chatting.";
    expect(stripActionBlocks(text)).toBe(text);
  });

  it("returns empty string when text is only an action block", () => {
    const text =
      '[ACTION]{"action":"archive","params":{"sessionId":"x"}}[/ACTION]';
    expect(stripActionBlocks(text)).toBe("");
  });

  it("handles action blocks with surrounding newlines", () => {
    const text =
      "I'll take care of that.\n\n[ACTION]{\"action\":\"cancel\",\"params\":{\"sessionId\":\"x\"}}[/ACTION]\n\n";
    const result = stripActionBlocks(text);
    expect(result).toBe("I'll take care of that.");
    expect(result).not.toContain("[ACTION]");
    expect(result).not.toContain("[/ACTION]");
  });

  it("strips action blocks but preserves STATUS_UPDATE blocks", () => {
    const text = [
      "Meeting cancelled.",
      '[ACTION]{"action":"cancel","params":{"sessionId":"x"}}[/ACTION]',
      '[STATUS_UPDATE]{"status":"cancelled","label":"Cancelled"}[/STATUS_UPDATE]',
    ].join(" ");
    const result = stripActionBlocks(text);
    expect(result).toContain("[STATUS_UPDATE]");
    expect(result).not.toContain("[ACTION]");
  });

  it("strips action blocks but preserves CONFIRMATION_PROPOSAL blocks", () => {
    const text = [
      "Confirmed!",
      '[ACTION]{"action":"update_format","params":{"sessionId":"x","format":"video"}}[/ACTION]',
      '[CONFIRMATION_PROPOSAL]{"dateTime":"2026-04-10T14:00:00-07:00","duration":30,"format":"video","location":null,"timezone":"America/Los_Angeles"}[/CONFIRMATION_PROPOSAL]',
    ].join(" ");
    const result = stripActionBlocks(text);
    expect(result).toContain("[CONFIRMATION_PROPOSAL]");
    expect(result).not.toContain("[ACTION]");
  });

  it("preserves markdown formatting in surrounding text", () => {
    const text =
      '**Done!** I\'ve archived the meeting.\n\n- Next steps: share a new link\n\n[ACTION]{"action":"archive","params":{"sessionId":"x"}}[/ACTION]';
    const result = stripActionBlocks(text);
    expect(result).toContain("**Done!**");
    expect(result).toContain("- Next steps:");
  });
});

// ─── Executor Tests (with Prisma mocks) ──────────────────────────────────────

// vi.hoisted runs before vi.mock, so we can create fns and reference them in the factory
const mockPrisma = vi.hoisted(() => ({
  negotiationSession: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  negotiationLink: {
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  message: {
    create: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/utils", () => ({ generateCode: () => "test-code-123" }));

// Test fixtures
const HOST_USER_ID = "host-user-1";
const OTHER_USER_ID = "other-user-2";

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    hostId: HOST_USER_ID,
    status: "active",
    title: "Q2 Planning — Sarah",
    archived: false,
    link: { inviteeName: "Sarah", topic: "Q2 Planning" },
    ...overrides,
  };
}

describe("executeActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.negotiationSession.update.mockResolvedValue({});
    mockPrisma.message.create.mockResolvedValue({});
  });

  // --- Archive ---

  describe("archive", () => {
    it("archives a session the user owns", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());

      const results = await executeActions(
        [{ action: "archive", params: { sessionId: "session-1" } }],
        HOST_USER_ID
      );

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].message).toContain("Sarah");
      expect(mockPrisma.negotiationSession.update).toHaveBeenCalledWith({
        where: { id: "session-1" },
        data: { archived: true },
      });
    });

    it("rejects archive for session owned by another user", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(
        makeSession({ hostId: OTHER_USER_ID })
      );

      const results = await executeActions(
        [{ action: "archive", params: { sessionId: "session-1" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("Not authorized");
      expect(mockPrisma.negotiationSession.update).not.toHaveBeenCalled();
    });

    it("rejects archive with missing sessionId", async () => {
      const results = await executeActions(
        [{ action: "archive", params: {} }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("Missing");
    });

    it("rejects archive for nonexistent session", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(null);

      const results = await executeActions(
        [{ action: "archive", params: { sessionId: "nonexistent" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("not found");
    });
  });

  // --- Archive Bulk ---

  describe("archive_bulk", () => {
    it("archives unconfirmed sessions", async () => {
      mockPrisma.negotiationSession.updateMany.mockResolvedValue({ count: 3 });

      const results = await executeActions(
        [{ action: "archive_bulk", params: { filter: "unconfirmed" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
      expect(results[0].message).toContain("3 sessions");
      expect(mockPrisma.negotiationSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            hostId: HOST_USER_ID,
            archived: false,
            status: { in: ["active", "proposed", "escalated"] },
          }),
          data: { archived: true },
        })
      );
    });

    it("archives expired sessions", async () => {
      mockPrisma.negotiationSession.updateMany.mockResolvedValue({ count: 1 });

      const results = await executeActions(
        [{ action: "archive_bulk", params: { filter: "expired" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
      expect(mockPrisma.negotiationSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "expired" }),
        })
      );
    });

    it("archives cancelled sessions", async () => {
      mockPrisma.negotiationSession.updateMany.mockResolvedValue({ count: 2 });

      const results = await executeActions(
        [{ action: "archive_bulk", params: { filter: "cancelled" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
      expect(results[0].message).toContain("2 sessions");
    });

    it("archives all sessions with 'all' filter", async () => {
      mockPrisma.negotiationSession.updateMany.mockResolvedValue({ count: 5 });

      const results = await executeActions(
        [{ action: "archive_bulk", params: { filter: "all" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
      expect(results[0].message).toContain("5 sessions");
    });

    it("reports zero sessions archived", async () => {
      mockPrisma.negotiationSession.updateMany.mockResolvedValue({ count: 0 });

      const results = await executeActions(
        [{ action: "archive_bulk", params: { filter: "expired" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
      expect(results[0].message).toContain("0 sessions");
    });

    it("rejects invalid filter", async () => {
      const results = await executeActions(
        [{ action: "archive_bulk", params: { filter: "bogus" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("Invalid filter");
    });

    it("rejects missing filter", async () => {
      const results = await executeActions(
        [{ action: "archive_bulk", params: {} }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(false);
    });
  });

  // --- Unarchive ---

  describe("unarchive", () => {
    it("unarchives a session", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(
        makeSession({ archived: true })
      );

      const results = await executeActions(
        [{ action: "unarchive", params: { sessionId: "session-1" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
      expect(mockPrisma.negotiationSession.update).toHaveBeenCalledWith({
        where: { id: "session-1" },
        data: { archived: false },
      });
    });
  });

  // --- Cancel ---

  describe("cancel", () => {
    it("cancels a session and creates a system message", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());

      const results = await executeActions(
        [{ action: "cancel", params: { sessionId: "session-1", reason: "Host unavailable" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
      expect(results[0].message).toContain("Sarah");
      expect(mockPrisma.negotiationSession.update).toHaveBeenCalledWith({
        where: { id: "session-1" },
        data: { status: "cancelled", statusLabel: "Host unavailable" },
      });
      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sessionId: "session-1",
          role: "system",
          content: expect.stringContaining("Host unavailable"),
        }),
      });
    });

    it("uses default reason when none provided", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());

      const results = await executeActions(
        [{ action: "cancel", params: { sessionId: "session-1" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
      expect(mockPrisma.negotiationSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ statusLabel: "Cancelled by host" }),
        })
      );
    });

    it("rejects cancel on already cancelled session", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(
        makeSession({ status: "cancelled" })
      );

      const results = await executeActions(
        [{ action: "cancel", params: { sessionId: "session-1" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("already cancelled");
      expect(mockPrisma.negotiationSession.update).not.toHaveBeenCalled();
    });
  });

  // --- Update Format ---

  describe("update_format", () => {
    it("updates format to video", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());

      const results = await executeActions(
        [{ action: "update_format", params: { sessionId: "session-1", format: "video" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
      expect(mockPrisma.negotiationSession.update).toHaveBeenCalledWith({
        where: { id: "session-1" },
        data: { format: "video" },
      });
    });

    it("accepts phone format", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());

      const results = await executeActions(
        [{ action: "update_format", params: { sessionId: "session-1", format: "phone" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
    });

    it("accepts in-person format", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());

      const results = await executeActions(
        [{ action: "update_format", params: { sessionId: "session-1", format: "in-person" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
    });

    it("rejects invalid format", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());

      const results = await executeActions(
        [{ action: "update_format", params: { sessionId: "session-1", format: "hologram" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("Invalid format");
    });

    it("rejects missing format", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());

      const results = await executeActions(
        [{ action: "update_format", params: { sessionId: "session-1" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(false);
    });

    it("uses context sessionId when params.sessionId is missing", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());

      const results = await executeActions(
        [{ action: "update_format", params: { format: "video" } }],
        HOST_USER_ID,
        { sessionId: "session-1" }
      );

      expect(results[0].success).toBe(true);
      expect(mockPrisma.negotiationSession.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "session-1" } })
      );
    });
  });

  // --- Update Time ---

  describe("update_time", () => {
    it("proposes a new time", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());

      const results = await executeActions(
        [{
          action: "update_time",
          params: {
            sessionId: "session-1",
            dateTime: "2026-04-10T14:00:00-07:00",
            timezone: "America/Los_Angeles",
          },
        }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
      expect(results[0].message).toContain("Proposed new time");
      expect(mockPrisma.negotiationSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "proposed",
            statusLabel: "Time change proposed by host",
          }),
        })
      );
      expect(mockPrisma.message.create).toHaveBeenCalled();
    });

    it("rejects missing dateTime", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());

      const results = await executeActions(
        [{ action: "update_time", params: { sessionId: "session-1" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("Missing dateTime");
    });

    it("rejects invalid dateTime", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());

      const results = await executeActions(
        [{ action: "update_time", params: { sessionId: "session-1", dateTime: "not-a-date" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("Invalid dateTime");
    });
  });

  // --- Update Location ---

  describe("update_location", () => {
    it("updates location and creates system message", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());

      const results = await executeActions(
        [{ action: "update_location", params: { sessionId: "session-1", location: "Café Nero" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
      expect(results[0].message).toContain("Café Nero");
      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          content: expect.stringContaining("Café Nero"),
        }),
      });
    });

    it("rejects missing location", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());

      const results = await executeActions(
        [{ action: "update_location", params: { sessionId: "session-1" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("Missing location");
    });
  });

  // --- Create Link ---

  describe("create_link", () => {
    it("creates a link and session", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ meetSlug: "john" });
      mockPrisma.negotiationLink.create.mockResolvedValue({ id: "link-1" });
      mockPrisma.negotiationSession.create.mockResolvedValue({ id: "new-session" });

      const results = await executeActions(
        [{
          action: "create_link",
          params: { inviteeName: "Sarah", topic: "Q3 Planning", format: "video", duration: 45 },
        }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
      expect(results[0].message).toContain("Sarah");
      expect(results[0].message).toContain("Q3 Planning");
      expect(results[0].data?.url).toContain("/meet/john/test-code-123");
      expect(mockPrisma.negotiationLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: HOST_USER_ID,
          type: "contextual",
          slug: "john",
          code: "test-code-123",
          inviteeName: "Sarah",
          topic: "Q3 Planning",
        }),
      });
      expect(mockPrisma.negotiationSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          hostId: HOST_USER_ID,
          title: "Q3 Planning — Sarah",
          format: "video",
          duration: 45,
        }),
      });
    });

    it("uses meetSlug from context when provided", async () => {
      mockPrisma.negotiationLink.create.mockResolvedValue({ id: "link-1" });
      mockPrisma.negotiationSession.create.mockResolvedValue({ id: "new-session" });

      const results = await executeActions(
        [{ action: "create_link", params: { inviteeName: "Noah" } }],
        HOST_USER_ID,
        { meetSlug: "john-ctx" }
      );

      expect(results[0].success).toBe(true);
      expect(results[0].data?.url).toContain("/meet/john-ctx/");
      // Should NOT call user.findUnique since meetSlug was in context
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("looks up meetSlug from user when not in context", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ meetSlug: "john-db" });
      mockPrisma.negotiationLink.create.mockResolvedValue({ id: "link-1" });
      mockPrisma.negotiationSession.create.mockResolvedValue({ id: "new-session" });

      const results = await executeActions(
        [{ action: "create_link", params: { inviteeName: "Noah" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
      expect(results[0].data?.url).toContain("/meet/john-db/");
    });

    it("fails when no meetSlug available", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ meetSlug: null });

      const results = await executeActions(
        [{ action: "create_link", params: { inviteeName: "Noah" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("No meet slug");
    });

    it("persists priority onto link rules when provided", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ meetSlug: "john" });
      mockPrisma.negotiationLink.create.mockResolvedValue({ id: "link-1" });
      mockPrisma.negotiationSession.create.mockResolvedValue({ id: "new-session" });

      await executeActions(
        [
          {
            action: "create_link",
            params: {
              inviteeName: "Katherine",
              topic: "Roadmap",
              format: "video",
              priority: "high",
            },
          },
        ],
        HOST_USER_ID
      );

      const call = mockPrisma.negotiationLink.create.mock.calls[0][0];
      expect(call.data.rules).toMatchObject({ priority: "high", format: "video" });
    });

    it("drops invalid priority values via normalizeLinkRules", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ meetSlug: "john" });
      mockPrisma.negotiationLink.create.mockResolvedValue({ id: "link-1" });
      mockPrisma.negotiationSession.create.mockResolvedValue({ id: "new-session" });

      await executeActions(
        [
          {
            action: "create_link",
            params: { inviteeName: "Noah", priority: "urgent" }, // not a canonical value
          },
        ],
        HOST_USER_ID
      );

      const call = mockPrisma.negotiationLink.create.mock.calls[0][0];
      expect(call.data.rules.priority).toBeUndefined();
    });

    it("handles missing optional fields gracefully", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ meetSlug: "john" });
      mockPrisma.negotiationLink.create.mockResolvedValue({ id: "link-1" });
      mockPrisma.negotiationSession.create.mockResolvedValue({ id: "new-session" });

      const results = await executeActions(
        [{ action: "create_link", params: {} }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
      expect(mockPrisma.negotiationLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          inviteeName: null,
          inviteeEmail: null,
          topic: null,
        }),
      });
    });
  });

  // --- Expand Link ---

  describe("expand_link", () => {
    const existingLink = {
      id: "link-1",
      userId: HOST_USER_ID,
      code: "hhkkkw",
      inviteeName: "Katherine",
      rules: { format: "video", duration: 30, preferredDays: ["Mon", "Tue"] },
    };

    it("upgrades priority by code", async () => {
      mockPrisma.negotiationLink.findFirst.mockResolvedValue(existingLink);
      mockPrisma.negotiationLink.update.mockResolvedValue({ id: "link-1" });

      const results = await executeActions(
        [{ action: "expand_link", params: { code: "hhkkkw", priority: "vip" } }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(true);
      expect(results[0].message).toContain("Katherine");
      expect(results[0].message).toContain("vip");
      // Merged rules should preserve existing fields AND have new priority
      const call = mockPrisma.negotiationLink.update.mock.calls[0][0];
      expect(call.data.rules).toMatchObject({
        format: "video",
        duration: 30,
        preferredDays: ["Mon", "Tue"],
        priority: "vip",
      });
    });

    it("downgrades priority (merge, not replace)", async () => {
      mockPrisma.negotiationLink.findFirst.mockResolvedValue({
        ...existingLink,
        rules: { ...existingLink.rules, priority: "vip" },
      });
      mockPrisma.negotiationLink.update.mockResolvedValue({ id: "link-1" });

      await executeActions(
        [{ action: "expand_link", params: { code: "hhkkkw", priority: "normal" } }],
        HOST_USER_ID
      );

      const call = mockPrisma.negotiationLink.update.mock.calls[0][0];
      expect(call.data.rules.priority).toBe("normal");
      // Other fields preserved
      expect(call.data.rules.preferredDays).toEqual(["Mon", "Tue"]);
    });

    it("narrows the daily time window via preferredTimeEnd", async () => {
      mockPrisma.negotiationLink.findFirst.mockResolvedValue(existingLink);
      mockPrisma.negotiationLink.update.mockResolvedValue({ id: "link-1" });

      await executeActions(
        [
          {
            action: "expand_link",
            params: { code: "hhkkkw", priority: "high", preferredTimeEnd: "10:00" },
          },
        ],
        HOST_USER_ID
      );

      const call = mockPrisma.negotiationLink.update.mock.calls[0][0];
      expect(call.data.rules.priority).toBe("high");
      expect(call.data.rules.preferredTimeEnd).toBe("10:00");
    });

    it("rejects when no identifying code or sessionId provided", async () => {
      const results = await executeActions(
        [{ action: "expand_link", params: { priority: "high" } }],
        HOST_USER_ID
      );
      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("code");
    });

    it("rejects when no mutation fields provided", async () => {
      mockPrisma.negotiationLink.findFirst.mockResolvedValue(existingLink);
      const results = await executeActions(
        [{ action: "expand_link", params: { code: "hhkkkw" } }],
        HOST_USER_ID
      );
      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("at least one field");
    });

    it("rejects when link not found", async () => {
      mockPrisma.negotiationLink.findFirst.mockResolvedValue(null);
      const results = await executeActions(
        [{ action: "expand_link", params: { code: "nope", priority: "vip" } }],
        HOST_USER_ID
      );
      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("not found");
    });

    it("rejects when link belongs to another user (session path)", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue({
        hostId: OTHER_USER_ID,
        linkId: "link-1",
        link: { ...existingLink, userId: OTHER_USER_ID },
      });
      const results = await executeActions(
        [{ action: "expand_link", params: { sessionId: "session-1", priority: "vip" } }],
        HOST_USER_ID
      );
      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("Not authorized");
    });
  });

  // --- Unknown Action ---

  describe("unknown actions", () => {
    it("returns failure for unknown action type", async () => {
      const results = await executeActions(
        [{ action: "self_destruct", params: {} }],
        HOST_USER_ID
      );

      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("Unknown action");
      expect(results[0].message).toContain("self_destruct");
    });
  });

  // --- Multi-Action ---

  describe("multi-action execution", () => {
    it("executes multiple actions sequentially", async () => {
      mockPrisma.negotiationSession.findUnique
        .mockResolvedValueOnce(makeSession({ id: "s1" }))
        .mockResolvedValueOnce(makeSession({ id: "s2" }));

      const results = await executeActions(
        [
          { action: "archive", params: { sessionId: "s1" } },
          { action: "archive", params: { sessionId: "s2" } },
        ],
        HOST_USER_ID
      );

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(mockPrisma.negotiationSession.update).toHaveBeenCalledTimes(2);
    });

    it("continues executing after a failed action", async () => {
      // First action fails (no session), second succeeds
      mockPrisma.negotiationSession.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeSession({ id: "s2" }));

      const results = await executeActions(
        [
          { action: "archive", params: { sessionId: "nonexistent" } },
          { action: "archive", params: { sessionId: "s2" } },
        ],
        HOST_USER_ID
      );

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(false);
      expect(results[1].success).toBe(true);
    });

    it("handles mixed action types", async () => {
      mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
      mockPrisma.negotiationSession.updateMany.mockResolvedValue({ count: 2 });

      const results = await executeActions(
        [
          { action: "cancel", params: { sessionId: "session-1" } },
          { action: "archive_bulk", params: { filter: "expired" } },
        ],
        HOST_USER_ID
      );

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true); // cancel
      expect(results[1].success).toBe(true); // archive_bulk
    });
  });

  // --- Error Resilience ---

  describe("error resilience", () => {
    it("handles Prisma errors gracefully", async () => {
      mockPrisma.negotiationSession.findUnique.mockRejectedValue(
        new Error("Connection refused")
      );

      const results = await executeActions(
        [{ action: "archive", params: { sessionId: "session-1" } }],
        HOST_USER_ID
      );

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("failed unexpectedly");
    });

    it("returns empty array for empty actions list", async () => {
      const results = await executeActions([], HOST_USER_ID);
      expect(results).toHaveLength(0);
    });
  });
});

// ─── Integration: Parse → Execute Pipeline ──────────────────────────────────

describe("parse → execute pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.negotiationSession.update.mockResolvedValue({});
    mockPrisma.message.create.mockResolvedValue({});
  });

  it("full pipeline: parse AI text → execute actions → strip display text", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());

    const aiResponse =
      'I\'ve cancelled the meeting with Sarah. [ACTION]{"action":"cancel","params":{"sessionId":"session-1","reason":"Host request"}}[/ACTION]';

    // Step 1: Parse
    const actions = parseActions(aiResponse);
    expect(actions).toHaveLength(1);

    // Step 2: Execute
    const results = await executeActions(actions, HOST_USER_ID);
    expect(results[0].success).toBe(true);

    // Step 3: Strip
    const displayText = stripActionBlocks(aiResponse);
    expect(displayText).toBe("I've cancelled the meeting with Sarah.");
    expect(displayText).not.toContain("[ACTION]");
  });

  it("pipeline with no actions passes through cleanly", async () => {
    const aiResponse = "Sure, I can check your schedule. You're free Tuesday afternoon.";

    const actions = parseActions(aiResponse);
    expect(actions).toHaveLength(0);

    const displayText = stripActionBlocks(aiResponse);
    expect(displayText).toBe(aiResponse);
  });

  it("pipeline with multiple actions and mixed results", async () => {
    mockPrisma.negotiationSession.findUnique
      .mockResolvedValueOnce(makeSession({ id: "s1" }))
      .mockResolvedValueOnce(null); // second one not found

    const aiResponse = [
      "Done! I've archived the Sarah meeting and attempted to cancel the unknown one.",
      '[ACTION]{"action":"archive","params":{"sessionId":"s1"}}[/ACTION]',
      '[ACTION]{"action":"cancel","params":{"sessionId":"nonexistent"}}[/ACTION]',
    ].join(" ");

    const actions = parseActions(aiResponse);
    expect(actions).toHaveLength(2);

    const results = await executeActions(actions, HOST_USER_ID);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);

    const displayText = stripActionBlocks(aiResponse);
    expect(displayText).not.toContain("[ACTION]");
    expect(displayText).toContain("Done!");
  });
});
