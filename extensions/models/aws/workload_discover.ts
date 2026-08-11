/**
 * Region-wide managed-workload discovery, added to the official
 * `@swamp/aws/ecs/cluster` model type.
 *
 * Groups the compute that isn't an EC2 instance — ECS services, EKS clusters and
 * Lambda functions. These share a diagramming concern: each attaches to subnets
 * and security groups rather than owning an instance, so they appear on the
 * network graph through their VPC configuration.
 *
 * They are collected under the ECS cluster type (rather than one model per
 * service) because ECS is the only one of the three whose official type needs no
 * create-only global arguments — extending `@swamp/aws/lambda/function` or
 * `@swamp/aws/eks/cluster` would force placeholder `Code`/`Role`/`RoleArn`
 * values into a read-only discovery definition.
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

/**
 * Parent types listed and hydrated.
 *
 * `AWS::ECS::TaskDefinition` is deliberately absent: ECS lists every historical
 * revision, so a long-lived account yields thousands of near-identical entries
 * and hydrating them dominates the whole run. Nothing is lost — each service
 * reports the exact revision it runs, which is the only one on the diagram.
 */
const PARENT_TYPES = [
  "AWS::ECS::Cluster",
  "AWS::EKS::Cluster",
  "AWS::Lambda::Function",
];

const CHILD_TYPES = [
  "AWS::ECS::Service",
  "AWS::EKS::Nodegroup",
  "AWS::EKS::FargateProfile",
];

/**
 * Derive child targets that CloudControl will not list standalone.
 *
 * ECS services are scoped to a cluster and EKS nodegroups to a cluster name, so
 * both need the parent identifier threaded through `ResourceModel`.
 */
function expandClusterChildren(found: DiscoveredResource[]): ListTarget[] {
  const targets: ListTarget[] = [];

  for (const resource of found) {
    if (resource.type === "AWS::ECS::Cluster") {
      const cluster = resource.identifier;
      if (!cluster) continue;
      targets.push({
        typeName: "AWS::ECS::Service",
        resourceModel: { Cluster: cluster },
      });
    }
    if (resource.type === "AWS::EKS::Cluster") {
      const clusterName = resource.identifier;
      if (!clusterName) continue;
      targets.push({
        typeName: "AWS::EKS::Nodegroup",
        resourceModel: { ClusterName: clusterName },
      });
      targets.push({
        typeName: "AWS::EKS::FargateProfile",
        resourceModel: { ClusterName: clusterName },
      });
    }
  }

  return targets;
}

/** Adds region-wide container and serverless discovery to the ECS Cluster model. */
export const extension = {
  type: "@swamp/aws/ecs/cluster",
  resources: {
    "inventory": inventoryResourceSpec,
  },
  methods: [{
    discover: {
      description:
        "Discover all ECS clusters and services, EKS clusters and nodegroups, and Lambda functions in a region",
      arguments: discoverArguments,
      execute: async (
        args: { region?: string },
        context: DiscoveryContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        return await runDiscovery(args, context, "workloads", [
          { types: PARENT_TYPES },
          { hydrate: PARENT_TYPES },
          { expand: expandClusterChildren },
          { hydrate: CHILD_TYPES },
        ]);
      },
    },
  }],
};
