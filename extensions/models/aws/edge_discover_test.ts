import { assert, assertEquals } from "jsr:@std/assert@1";
import { expandListeners, extension } from "./edge_discover.ts";
import type { DiscoveredResource } from "./_lib/cloudcontrol.ts";

function resource(type: string, identifier: string): DiscoveredResource {
  return { type, identifier, properties: {} };
}

Deno.test("extends the official ELBv2 load balancer type", () => {
  assertEquals(
    extension.type,
    "@swamp/aws/elasticloadbalancingv2/load-balancer",
  );
  assert("inventory" in extension.resources);
  assert("discover" in extension.methods[0]);
});

Deno.test("expandListeners scopes listeners to each load balancer", () => {
  const arn = "arn:aws:elasticloadbalancing:eu-west-2:1:loadbalancer/app/a/b";
  const targets = expandListeners([
    resource("AWS::ElasticLoadBalancingV2::LoadBalancer", arn),
  ]);

  assertEquals(targets, [{
    typeName: "AWS::ElasticLoadBalancingV2::Listener",
    resourceModel: { LoadBalancerArn: arn },
  }]);
});

Deno.test("expandListeners ignores target groups and blank identifiers", () => {
  const targets = expandListeners([
    resource("AWS::ElasticLoadBalancingV2::TargetGroup", "arn:tg"),
    resource("AWS::ElasticLoadBalancingV2::LoadBalancer", ""),
  ]);

  assertEquals(targets, []);
});

Deno.test("expandListeners fans out across every balancer found", () => {
  const targets = expandListeners([
    resource("AWS::ElasticLoadBalancingV2::LoadBalancer", "arn:a"),
    resource("AWS::ElasticLoadBalancingV2::LoadBalancer", "arn:b"),
  ]);

  assertEquals(
    targets.map((target) => target.resourceModel?.LoadBalancerArn),
    ["arn:a", "arn:b"],
  );
});
