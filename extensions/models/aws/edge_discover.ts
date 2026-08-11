/**
 * Region-wide ingress-edge discovery, added to the official
 * `@swamp/aws/elasticloadbalancingv2/load-balancer` model type.
 *
 * Load balancers are where inbound traffic enters the estate, so this domain
 * supplies the diagram's public entry points: the balancers, the ports they
 * listen on, and the target groups that bind those ports to compute.
 *
 * @module
 */

import {
  discoverArguments,
  type DiscoveryContext,
  inventoryResourceSpec,
  runDiscovery,
} from "./_lib/inventory.ts";
import type { DiscoveredResource, ListTarget } from "./_lib/cloudcontrol.ts";

const EDGE_TYPES = [
  "AWS::ElasticLoadBalancingV2::LoadBalancer",
  "AWS::ElasticLoadBalancingV2::TargetGroup",
];

/**
 * Listeners are only listable per load balancer, so fan out over what the first
 * phase found.
 */
export function expandListeners(found: DiscoveredResource[]): ListTarget[] {
  const targets: ListTarget[] = [];
  for (const resource of found) {
    if (resource.type !== "AWS::ElasticLoadBalancingV2::LoadBalancer") continue;
    const arn = resource.identifier;
    if (!arn) continue;
    targets.push({
      typeName: "AWS::ElasticLoadBalancingV2::Listener",
      resourceModel: { LoadBalancerArn: arn },
    });
  }
  return targets;
}

/** Adds region-wide load balancer discovery to the official ELBv2 model. */
export const extension = {
  type: "@swamp/aws/elasticloadbalancingv2/load-balancer",
  resources: {
    "inventory": inventoryResourceSpec,
  },
  methods: [{
    discover: {
      description:
        "Discover all load balancers, listeners and target groups in a region",
      arguments: discoverArguments,
      execute: async (
        args: { region?: string },
        context: DiscoveryContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        return await runDiscovery(args, context, "edge", [
          { types: EDGE_TYPES },
          { hydrate: EDGE_TYPES },
          { expand: expandListeners },
          { hydrate: ["AWS::ElasticLoadBalancingV2::Listener"] },
        ]);
      },
    },
  }],
};
