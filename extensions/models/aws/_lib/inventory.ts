// Shared inventory resource shape and discovery driver for the AWS topology
// extensions. Each domain extension (network, compute, workloads, edge) declares
// which CloudControl types it owns and hands them to `runDiscovery`, which does
// the listing, pagination, error tolerance and resource write.
//
// @module

import { z } from "npm:zod@4";
import {
  buildCredentials,
  createClient,
  type DiscoveredResource,
  discoverTypes,
  type DiscoveryLogger,
  type DiscoveryResult,
  hydrateResources,
  type ListTarget,
  resolveRegion,
} from "./cloudcontrol.ts";

/** Schema for the `inventory` resource added to each extended AWS type. */
export const InventorySchema = z.object({
  domain: z.string().describe(
    "Discovery domain: network, compute, workloads or edge.",
  ),
  region: z.string().describe("AWS region the inventory was taken from."),
  discoveredAt: z.string().describe("ISO-8601 timestamp of the discovery run."),
  resourceCount: z.number().describe("Total resources discovered."),
  counts: z.record(z.string(), z.number()).describe(
    "Resource count keyed by CloudFormation type name.",
  ),
  resources: z.array(
    z.object({
      type: z.string(),
      identifier: z.string(),
      properties: z.record(z.string(), z.unknown()),
    }),
  ).describe("Every discovered resource with its CloudControl properties."),
  errors: z.array(z.object({ type: z.string(), message: z.string() }))
    .describe("Types that could not be listed, with the reason."),
  truncated: z.boolean().describe(
    "True when any type hit the pagination ceiling, so this inventory is incomplete.",
  ),
  truncatedTypes: z.array(z.string()).describe(
    "The types whose listing was cut short by the pagination ceiling.",
  ),
});

/** Inventory payload produced by a discovery run. */
export type Inventory = z.infer<typeof InventorySchema>;

/** Resource spec merged into each extended AWS model type. */
export const inventoryResourceSpec = {
  description:
    "Region-wide inventory of this domain, used to build the architecture diagram",
  schema: InventorySchema,
  lifetime: "infinite" as const,
  garbageCollection: 12,
};

/** Arguments accepted by every `discover` method. */
export const discoverArguments: z.ZodType = z.object({
  region: z.string().optional().describe(
    "AWS region to inventory. Defaults to the model's region global argument, then AWS_REGION, then eu-west-2.",
  ),
});

/**
 * One step of a discovery plan.
 *
 * A `types` phase lists those CloudControl types outright. An `expand` phase
 * derives its targets from what earlier phases found — needed for child types
 * CloudControl won't list without parent context (ECS services need a cluster,
 * ELBv2 listeners need a load balancer ARN).
 */
export type DiscoveryPhase =
  | { types: string[] }
  | { expand: (found: DiscoveredResource[]) => ListTarget[] }
  | { hydrate: string[] };

/** Minimal shape of the method context used by discovery. */
export interface DiscoveryContext {
  globalArgs: Record<string, unknown>;
  logger?: DiscoveryLogger;
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
}

/**
 * Run a discovery plan and write the resulting inventory.
 *
 * Returns the swamp method result so callers can `return` it directly.
 */
export async function runDiscovery(
  args: { region?: string },
  context: DiscoveryContext,
  domain: string,
  phases: DiscoveryPhase[],
): Promise<{ dataHandles: unknown[] }> {
  const region = resolveRegion(args.region, context.globalArgs);
  const credentials = buildCredentials(context.globalArgs);
  const client = createClient(region, credentials);
  const logger = context.logger;

  logger?.info("Discovering {domain} in {region}", { domain, region });

  const combined: DiscoveryResult = {
    resources: [],
    errors: [],
    counts: {},
    truncatedTypes: [],
  };
  // Parent-scoped listings overlap heavily — asking each of 47 route tables for
  // its subnet associations returns the VPC's whole association set every time.
  // Keying on type + identifier keeps the first copy and drops the rest, so
  // hydration doesn't pay for the same resource dozens of times over.
  const seen = new Set<string>();

  const absorb = (found: DiscoveredResource[]): void => {
    for (const resource of found) {
      const key = `${resource.type}|${resource.identifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      combined.resources.push(resource);
    }
  };

  for (const phase of phases) {
    if ("hydrate" in phase) {
      const hydrationErrors = await hydrateResources(
        client,
        combined.resources,
        phase.hydrate,
        logger,
      );
      combined.errors.push(...hydrationErrors);
      continue;
    }

    const targets: ListTarget[] = "types" in phase
      ? phase.types.map((typeName) => ({ typeName }))
      : phase.expand(combined.resources);
    if (targets.length === 0) continue;

    const result = await discoverTypes(client, targets, logger);
    absorb(result.resources);
    combined.errors.push(...result.errors);
    for (const typeName of result.truncatedTypes) {
      if (!combined.truncatedTypes.includes(typeName)) {
        combined.truncatedTypes.push(typeName);
      }
    }
    for (const typeName of Object.keys(result.counts)) {
      combined.counts[typeName] = combined.counts[typeName] ?? 0;
    }
  }

  for (const resource of combined.resources) {
    combined.counts[resource.type] = (combined.counts[resource.type] ?? 0) + 1;
  }

  const inventory: Inventory = {
    domain,
    region,
    discoveredAt: new Date().toISOString(),
    resourceCount: combined.resources.length,
    counts: combined.counts,
    resources: combined.resources,
    errors: combined.errors,
    truncated: combined.truncatedTypes.length > 0,
    truncatedTypes: combined.truncatedTypes,
  };

  logger?.info("Discovered {count} {domain} resources in {region}", {
    count: combined.resources.length,
    domain,
    region,
  });

  const handle = await context.writeResource("inventory", "inventory", {
    ...inventory,
  });
  return { dataHandles: [handle] };
}
