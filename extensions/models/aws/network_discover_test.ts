import { assert, assertEquals } from "jsr:@std/assert@1";
import { expandRouting, extension } from "./network_discover.ts";
import type { DiscoveredResource } from "./_lib/cloudcontrol.ts";

function resource(
  type: string,
  identifier: string,
  properties: Record<string, unknown> = {},
): DiscoveredResource {
  return { type, identifier, properties };
}

Deno.test("extends the official VPC type rather than declaring a new one", () => {
  assertEquals(extension.type, "@swamp/aws/ec2/vpc");
  assert("inventory" in extension.resources);
  assert("discover" in extension.methods[0]);
});

Deno.test("expandRouting asks each route table for its routes and associations", () => {
  const targets = expandRouting([resource("AWS::EC2::RouteTable", "rtb-1")]);

  assertEquals(targets.length, 2);
  assertEquals(targets[0], {
    typeName: "AWS::EC2::Route",
    resourceModel: { RouteTableId: "rtb-1" },
  });
  assertEquals(targets[1], {
    typeName: "AWS::EC2::SubnetRouteTableAssociation",
    resourceModel: { RouteTableId: "rtb-1" },
  });
});

Deno.test("expandRouting asks each VPC for its gateway attachments", () => {
  const targets = expandRouting([resource("AWS::EC2::VPC", "vpc-1")]);

  assertEquals(targets, [{
    typeName: "AWS::EC2::VPCGatewayAttachment",
    resourceModel: { VpcId: "vpc-1" },
  }]);
});

Deno.test("expandRouting never asks for network ACL entries", () => {
  // CloudControl has no LIST handler for AWS::EC2::NetworkAclEntry; requesting
  // it only produces one tolerated error per ACL.
  const targets = expandRouting([resource("AWS::EC2::NetworkAcl", "acl-1")]);

  assertEquals(targets, []);
});

Deno.test("expandRouting ignores types with no children and blank identifiers", () => {
  const targets = expandRouting([
    resource("AWS::EC2::SecurityGroup", "sg-1"),
    resource("AWS::EC2::RouteTable", ""),
    resource("AWS::EC2::VPC", ""),
  ]);

  assertEquals(targets, []);
});

Deno.test("expandRouting scopes every route table independently", () => {
  const targets = expandRouting([
    resource("AWS::EC2::RouteTable", "rtb-1"),
    resource("AWS::EC2::RouteTable", "rtb-2"),
  ]);

  const routeTables = targets
    .filter((target) => target.typeName === "AWS::EC2::Route")
    .map((target) => target.resourceModel?.RouteTableId);
  assertEquals(routeTables, ["rtb-1", "rtb-2"]);
});
