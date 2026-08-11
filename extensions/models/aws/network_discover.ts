/**
 * Region-wide network discovery, added to the official `@swamp/aws/ec2/vpc`
 * model type.
 *
 * The official type covers the VPC domain but only one VPC at a time. This
 * extension adds the missing fan-out: a single `discover` call inventories every
 * network object in a region — the VPCs and subnets that form the boundaries,
 * and every object that carries traffic across them (route tables, gateways,
 * endpoints, peerings, transit gateways, VPNs) plus the filters that permit it
 * (security groups, network ACLs).
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

/** Network types that CloudControl lists without parent context. */
const NETWORK_TYPES = [
  "AWS::EC2::VPC",
  "AWS::EC2::Subnet",
  "AWS::EC2::RouteTable",
  "AWS::EC2::InternetGateway",
  "AWS::EC2::EgressOnlyInternetGateway",
  "AWS::EC2::NatGateway",
  "AWS::EC2::VPCEndpoint",
  "AWS::EC2::VPCPeeringConnection",
  "AWS::EC2::TransitGateway",
  "AWS::EC2::TransitGatewayAttachment",
  "AWS::EC2::VPNConnection",
  "AWS::EC2::VPNGateway",
  "AWS::EC2::CustomerGateway",
  "AWS::EC2::NetworkAcl",
  "AWS::EC2::SecurityGroup",
  "AWS::EC2::NetworkInterface",
  "AWS::EC2::EIP",
  "AWS::EC2::PrefixList",
];

/**
 * Types whose listing returns nothing but a primary identifier.
 *
 * A VPC's CIDR, a security group's rules and a peering connection's accepter all
 * live behind `GetResource`, and every one of them is load-bearing for the
 * diagram — without hydration the topology is a bag of opaque IDs.
 */
const SPARSE_TYPES = [
  "AWS::EC2::VPC",
  "AWS::EC2::RouteTable",
  "AWS::EC2::SecurityGroup",
  "AWS::EC2::InternetGateway",
  "AWS::EC2::EgressOnlyInternetGateway",
  "AWS::EC2::NatGateway",
  "AWS::EC2::VPCPeeringConnection",
  "AWS::EC2::NetworkAcl",
  "AWS::EC2::TransitGateway",
  "AWS::EC2::TransitGatewayAttachment",
  "AWS::EC2::VPNConnection",
  "AWS::EC2::VPNGateway",
  "AWS::EC2::CustomerGateway",
];

/**
 * Routing types discovered by expansion, which also list identifier-only.
 *
 * A route without its target is just a destination CIDR — the gateway, NAT,
 * peering or interface it points at is the whole payload, and it only arrives
 * via `GetResource`.
 */
const ROUTING_TYPES = [
  "AWS::EC2::Route",
  "AWS::EC2::SubnetRouteTableAssociation",
  "AWS::EC2::VPCGatewayAttachment",
];

/**
 * Derive the per-parent listings that make routing legible.
 *
 * Routes are separate resources from their table in the CloudFormation schema,
 * and CloudControl will only list them when told which table to look in. The
 * same is true of subnet associations (which subnet uses which table) and
 * gateway attachments (which VPC an internet gateway is bolted to) — between
 * them these three are what turn a list of gateways into actual paths.
 *
 * Network ACL entries are deliberately not expanded: CloudControl has no LIST
 * handler for `AWS::EC2::NetworkAclEntry`, so asking only produces noise.
 */
export function expandRouting(found: DiscoveredResource[]): ListTarget[] {
  const targets: ListTarget[] = [];

  for (const resource of found) {
    if (resource.type === "AWS::EC2::RouteTable" && resource.identifier) {
      targets.push({
        typeName: "AWS::EC2::Route",
        resourceModel: { RouteTableId: resource.identifier },
      });
      targets.push({
        typeName: "AWS::EC2::SubnetRouteTableAssociation",
        resourceModel: { RouteTableId: resource.identifier },
      });
    }
    if (resource.type === "AWS::EC2::VPC" && resource.identifier) {
      targets.push({
        typeName: "AWS::EC2::VPCGatewayAttachment",
        resourceModel: { VpcId: resource.identifier },
      });
    }
  }

  return targets;
}

/** Adds region-wide network discovery to the official EC2 VPC model. */
export const extension = {
  type: "@swamp/aws/ec2/vpc",
  resources: {
    "inventory": inventoryResourceSpec,
  },
  methods: [{
    discover: {
      description:
        "Discover all VPCs, subnets, gateways, routes and filters in a region",
      arguments: discoverArguments,
      execute: async (
        args: { region?: string },
        context: DiscoveryContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        return await runDiscovery(args, context, "network", [
          { types: NETWORK_TYPES },
          { hydrate: SPARSE_TYPES },
          { expand: expandRouting },
          { hydrate: ROUTING_TYPES },
        ]);
      },
    },
  }],
};
