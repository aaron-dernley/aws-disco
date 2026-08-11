import { assert, assertEquals } from "jsr:@std/assert@1";
import { expandClusterChildren, extension } from "./workload_discover.ts";
import type { DiscoveredResource } from "./_lib/cloudcontrol.ts";

function resource(type: string, identifier: string): DiscoveredResource {
  return { type, identifier, properties: {} };
}

Deno.test("extends the official ECS cluster type", () => {
  assertEquals(extension.type, "@swamp/aws/ecs/cluster");
  assert("inventory" in extension.resources);
  assert("discover" in extension.methods[0]);
});

Deno.test("expandClusterChildren scopes ECS services to their cluster", () => {
  const targets = expandClusterChildren([resource("AWS::ECS::Cluster", "prod")]);

  assertEquals(targets, [{
    typeName: "AWS::ECS::Service",
    resourceModel: { Cluster: "prod" },
  }]);
});

Deno.test("expandClusterChildren scopes EKS node groups and Fargate profiles", () => {
  const targets = expandClusterChildren([resource("AWS::EKS::Cluster", "eks-1")]);

  assertEquals(targets.map((target) => target.typeName), [
    "AWS::EKS::Nodegroup",
    "AWS::EKS::FargateProfile",
  ]);
  for (const target of targets) {
    assertEquals(target.resourceModel, { ClusterName: "eks-1" });
  }
});

Deno.test("expandClusterChildren skips resources with no identifier", () => {
  const targets = expandClusterChildren([
    resource("AWS::ECS::Cluster", ""),
    resource("AWS::EKS::Cluster", ""),
  ]);

  assertEquals(targets, []);
});

Deno.test("expandClusterChildren ignores unrelated types", () => {
  const targets = expandClusterChildren([
    resource("AWS::Lambda::Function", "fn-1"),
    resource("AWS::ECS::TaskDefinition", "td-1:4"),
  ]);

  assertEquals(targets, []);
});

Deno.test("task definitions are not listed — ECS returns every revision", () => {
  // Listing AWS::ECS::TaskDefinition returns thousands of historical revisions
  // and dominates the run; each service reports the revision it actually uses.
  const description = extension.methods[0].discover.description;
  assert(!description.includes("task definition"));
});
