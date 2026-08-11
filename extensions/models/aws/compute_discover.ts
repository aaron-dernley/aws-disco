/**
 * Region-wide instance compute discovery, added to the official
 * `@swamp/aws/ec2/instance` model type.
 *
 * Covers the machines themselves and the things that create them, so the diagram
 * can show an autoscaling group as one node rather than N anonymous instances.
 *
 * @module
 */

import {
  discoverArguments,
  type DiscoveryContext,
  inventoryResourceSpec,
  runDiscovery,
} from "./_lib/inventory.ts";

const COMPUTE_TYPES = [
  "AWS::EC2::Instance",
  "AWS::AutoScaling::AutoScalingGroup",
  "AWS::EC2::LaunchTemplate",
  "AWS::EC2::Host",
  "AWS::EC2::SpotFleet",
];

/** Adds region-wide compute discovery to the official EC2 Instance model. */
export const extension = {
  type: "@swamp/aws/ec2/instance",
  resources: {
    "inventory": inventoryResourceSpec,
  },
  methods: [{
    discover: {
      description:
        "Discover all EC2 instances, autoscaling groups and launch templates in a region",
      arguments: discoverArguments,
      execute: async (
        args: { region?: string },
        context: DiscoveryContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        return await runDiscovery(args, context, "compute", [
          { types: COMPUTE_TYPES },
          { hydrate: COMPUTE_TYPES },
        ]);
      },
    },
  }],
};
