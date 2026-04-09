import { readFileSync } from "fs";
import { join } from "path";
import type { AgentConfig, ResearchResult, Synthesis } from "./types";

const PLAYBOOK_PATH = join(process.cwd(), "src", "lib", "negotiator", "playbooks", "administrator.md");

function loadPlaybook(): string {
  try {
    return readFileSync(PLAYBOOK_PATH, "utf-8");
  } catch {
    // Fallback for Vercel where cwd differs
    try {
      return readFileSync(
        join(__dirname, "..", "..", "lib", "negotiator", "playbooks", "administrator.md"),
        "utf-8"
      );
    } catch {
      console.error("Failed to load administrator playbook");
      return "";
    }
  }
}

interface ComposeOptions {
  question: string;
  sharedContext: string;
  hostPrivateContext: string;
  agents: AgentConfig[];
  research: ResearchResult[];
}

export function composeAdministratorPrompt(opts: ComposeOptions): string {
  const sections: string[] = [];

  // 1. Playbook
  sections.push(loadPlaybook());

  // 2. Scenario
  sections.push(`# Scenario\n\nQuestion: ${opts.question}`);

  // 3. Shared context
  if (opts.sharedContext) {
    sections.push(
      `# Shared Context (visible to all agents)\n\n${opts.sharedContext}`
    );
  }

  // 4. Host's private context
  if (opts.hostPrivateContext) {
    sections.push(
      `# Host's Private Context (CONFIDENTIAL — do not share with any agent)\n\n${opts.hostPrivateContext}`
    );
  }

  // 5. Each agent's position + private context
  for (const agent of opts.agents) {
    const research = opts.research.find((r) => r.agentId === agent.id);
    const position = research?.content || "(no position submitted)";

    const agentSection = [
      `# Agent: ${agent.name} (${agent.id})`,
    ];

    if (agent.context) {
      agentSection.push(
        `## Private Context (CONFIDENTIAL — do not share with other agents)\n${agent.context}`
      );
    }

    agentSection.push(`## Position\n${position}`);
    sections.push(agentSection.join("\n\n"));
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Parse the administrator's response into a Synthesis object.
 * The administrator should return raw JSON (no markdown fencing).
 */
export function parseSynthesis(text: string): Synthesis {
  // Try parsing the raw text first
  try {
    return JSON.parse(text.trim());
  } catch {
    // Fall back: try extracting JSON from markdown fencing
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch {
        // ignore
      }
    }

    // Last resort: try to find a JSON object in the text
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]);
      } catch {
        // ignore
      }
    }

    // Complete failure — return a stub
    return {
      agentLabels: {},
      proposals: [],
      commonGround: [],
      keyDifferences: [],
      recommendation: { route: "pick", confidence: 0, agentId: "", reasoning: "Failed to parse administrator response." },
      summary: "Failed to parse administrator response. Raw output: " + text.slice(0, 500),
    };
  }
}
