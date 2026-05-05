/**
 * Module registry — keyed by (surface, intent).
 *
 * Modules register themselves at import time via `registerModule()`. Surface
 * adapters (route handlers) look up by `(surface, intent)` from this registry.
 *
 * Per the contract test in `intent-module-contract.test.ts`: every host
 * intent in `HOST_CHAT_INTENT_VALUES` must have a registered module on
 * `dashboard-host`. Misses fail the test loudly. PR1a ships a single
 * smoke module (`chat`) so the contract test has at least one module
 * to validate; subsequent PRs register the real ones.
 */
import type { IntentModule, ModuleRegistry } from "./types";

const REGISTRY_INTERNAL: { [k: string]: { [intent: string]: IntentModule } } = {};

export function registerModule(module: IntentModule): void {
  REGISTRY_INTERNAL[module.surface] = REGISTRY_INTERNAL[module.surface] ?? {};
  if (REGISTRY_INTERNAL[module.surface][module.intent]) {
    throw new Error(
      `Duplicate module registration: ${module.surface}/${module.intent}. ` +
        `Each (surface, intent) pair may have only one module.`,
    );
  }
  REGISTRY_INTERNAL[module.surface][module.intent] = module;
}

export function lookupModule(
  surface: string,
  intent: string,
): IntentModule | null {
  return REGISTRY_INTERNAL[surface]?.[intent] ?? null;
}

export function getRegistry(): ModuleRegistry {
  return REGISTRY_INTERNAL as ModuleRegistry;
}

/**
 * Test-only helper. Resets the registry between tests. NEVER call from
 * production code paths.
 */
export function _resetRegistryForTests(): void {
  for (const k of Object.keys(REGISTRY_INTERNAL)) {
    delete REGISTRY_INTERNAL[k];
  }
}
