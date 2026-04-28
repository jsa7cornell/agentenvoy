export const DEFAULT_TOKEN_BUDGET = 50_000;
export const MIN_TOKEN_BUDGET = 10_000;
export const MAX_TOKEN_BUDGET = 200_000;
export const BUDGET_STEPS = [10_000, 25_000, 50_000, 100_000, 200_000];

export function isOverBudget(used: number, budget: number): boolean {
  return used >= budget;
}

export function budgetRemaining(used: number, budget: number): number {
  return Math.max(0, budget - used);
}

export function budgetPercent(used: number, budget: number): number {
  return Math.min(100, Math.round((used / budget) * 100));
}
