/**
 * The deployment's one detector registry for content rules. Every place that runs or lists checks uses it: workflow
 * runs (and their sub-workflows), gateway tool calls, AI gateway requests, simulations, the detector list, the
 * benchmark and the content rules tools. A deployment-level engine (the recognizer behind `data.entities`) therefore
 * reaches every check, and the verdict memo keys on its version.
 *
 * Without a configured recognizer the built-in rules stand in, and the registry behaves exactly like the engine's
 * own default (the egress check resolves hostnames through the system resolver).
 */

import {
  createDefaultGuardRegistry,
  entityEngineInfo,
  type DnsResolver,
  type GuardEntityRecognizer,
  type GuardRegistry
} from "@ai-orchestrator/guard-sdk";
import type { GuardEntityEngineInfo } from "@ai-orchestrator/shared";
import { systemDnsResolver } from "@ai-orchestrator/workflow-engine";

export interface DeploymentGuardRegistry {
  registry: GuardRegistry;
  /** The deployment's recognizer for names and addresses; absent: the built-in rules. */
  entityRecognizer?: GuardEntityRecognizer;
  /** What the detector list shows about the `data.entities` engine. */
  entityEngine(): GuardEntityEngineInfo;
}

export interface DeploymentGuardRegistryOptions {
  entityRecognizer?: GuardEntityRecognizer;
  /** Default: the system resolver. */
  resolver?: DnsResolver;
}

export function createDeploymentGuardRegistry(options: DeploymentGuardRegistryOptions = {}): DeploymentGuardRegistry {
  const entityRecognizer = options.entityRecognizer;
  const registry = createDefaultGuardRegistry({
    resolver: options.resolver ?? systemDnsResolver,
    ...(entityRecognizer ? { entityRecognizer } : {})
  });
  return {
    registry,
    ...(entityRecognizer ? { entityRecognizer } : {}),
    entityEngine: () => entityEngineInfo(entityRecognizer)
  };
}
