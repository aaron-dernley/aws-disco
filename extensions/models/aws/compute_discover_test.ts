import { assert, assertArrayIncludes, assertEquals } from "jsr:@std/assert@1";
import { COMPUTE_TYPES, extension } from "./compute_discover.ts";

Deno.test("extends the official EC2 instance type", () => {
  assertEquals(extension.type, "@swamp/aws/ec2/instance");
  assert("inventory" in extension.resources);
  assert("discover" in extension.methods[0]);
});

Deno.test("covers the instances and the things that create them", () => {
  assertArrayIncludes(COMPUTE_TYPES, [
    "AWS::EC2::Instance",
    "AWS::AutoScaling::AutoScalingGroup",
    "AWS::EC2::LaunchTemplate",
  ]);
});

Deno.test("declares the inventory resource the diagram reads", () => {
  const spec = extension.resources.inventory;
  assertEquals(spec.lifetime, "infinite");
  assert(typeof spec.garbageCollection === "number");
});

Deno.test("discover takes an optional region argument", () => {
  const parsed = extension.methods[0].discover.arguments.safeParse({});
  assert(parsed.success, "region must be optional so the model default applies");

  const withRegion = extension.methods[0].discover.arguments.safeParse({
    region: "eu-west-1",
  });
  assert(withRegion.success);
});
