import { AsyncLocalStorage } from "node:async_hooks";
import { executorPathReachability } from "../metrics/registry.js";

const flowDryRunBoundary = new AsyncLocalStorage<{ active: true }>();

export async function runWithFlowDryRunExecutionBoundary<T>(
  callback: () => Promise<T>,
): Promise<T> {
  return flowDryRunBoundary.run({ active: true }, callback);
}

export function assertExecutorPathNotReachableFromFlowDryRun(path: string): void {
  if (!flowDryRunBoundary.getStore()?.active) {
    return;
  }

  executorPathReachability.inc({ path });
  throw new Error(`flow dry-run executor boundary violation: ${path}`);
}
