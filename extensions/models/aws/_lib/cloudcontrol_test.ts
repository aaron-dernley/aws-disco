import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  buildCredentials,
  discoverTypes,
  hydrateResources,
  isProgrammerError,
  isTolerableListError,
  listResources,
  resolveRegion,
} from "./cloudcontrol.ts";

/**
 * Minimal stand-in for CloudControlClient.
 *
 * The real client is only ever used through `send`, so a stub is enough to
 * exercise pagination, truncation and error tolerance without touching AWS.
 */
// deno-lint-ignore no-explicit-any
function stubClient(handler: (input: any) => unknown): any {
  return {
    // deno-lint-ignore no-explicit-any
    send(command: any) {
      return Promise.resolve(handler(command.input));
    },
  };
}

function described(ids: string[], properties: Record<string, unknown> = {}) {
  return ids.map((id) => ({
    Identifier: id,
    Properties: JSON.stringify({ Id: id, ...properties }),
  }));
}

Deno.test("listResources follows pagination to the end", async () => {
  const client = stubClient((input) =>
    input.NextToken === "p2"
      ? { ResourceDescriptions: described(["c"]) }
      : input.NextToken === "p1"
      ? { ResourceDescriptions: described(["b"]), NextToken: "p2" }
      : { ResourceDescriptions: described(["a"]), NextToken: "p1" }
  );

  const outcome = await listResources(client, { typeName: "AWS::EC2::VPC" });

  assertEquals(outcome.resources.map((r) => r.identifier), ["a", "b", "c"]);
  assertEquals(outcome.truncated, false);
});

Deno.test("listResources reports truncation when the page budget runs out", async () => {
  // A server that never stops paginating: the listing is incomplete and must
  // say so rather than looking like a full result.
  const client = stubClient(() => ({
    ResourceDescriptions: described(["x"]),
    NextToken: "always-more",
  }));

  const outcome = await listResources(client, { typeName: "AWS::EC2::VPC" });

  assertEquals(outcome.truncated, true);
  assert(outcome.resources.length > 0);
});

Deno.test("listResources keeps the identifier when properties are malformed", async () => {
  const client = stubClient(() => ({
    ResourceDescriptions: [{ Identifier: "vpc-1", Properties: "{not json" }],
  }));

  const outcome = await listResources(client, { typeName: "AWS::EC2::VPC" });

  assertEquals(outcome.resources[0].identifier, "vpc-1");
  assertEquals(outcome.resources[0].properties, {});
});

Deno.test("listResources passes parent context through as ResourceModel", async () => {
  let seen: string | undefined;
  const client = stubClient((input) => {
    seen = input.ResourceModel;
    return { ResourceDescriptions: [] };
  });

  await listResources(client, {
    typeName: "AWS::EC2::Route",
    resourceModel: { RouteTableId: "rtb-1" },
  });

  assertEquals(seen, JSON.stringify({ RouteTableId: "rtb-1" }));
});

Deno.test("discoverTypes records an unlistable type and carries on", async () => {
  const client = stubClient((input) => {
    if (input.TypeName === "AWS::EC2::NetworkAclEntry") {
      const error = new Error(
        "Resource type AWS::EC2::NetworkAclEntry does not support LIST action",
      );
      error.name = "UnsupportedActionException";
      throw error;
    }
    return { ResourceDescriptions: described(["vpc-1"]) };
  });

  const result = await discoverTypes(client, [
    { typeName: "AWS::EC2::NetworkAclEntry" },
    { typeName: "AWS::EC2::VPC" },
  ]);

  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].type, "AWS::EC2::NetworkAclEntry");
  assertEquals(result.counts["AWS::EC2::NetworkAclEntry"], 0);
  assertEquals(result.counts["AWS::EC2::VPC"], 1);
});

Deno.test("discoverTypes rethrows errors that are not merely a missing capability", async () => {
  const client = stubClient(() => {
    throw new TypeError("undefined is not a function");
  });

  await assertRejects(
    () => discoverTypes(client, [{ typeName: "AWS::EC2::VPC" }]),
    TypeError,
  );
});

Deno.test("discoverTypes surfaces truncation per type", async () => {
  const client = stubClient(() => ({
    ResourceDescriptions: described(["x"]),
    NextToken: "more",
  }));

  const result = await discoverTypes(client, [{
    typeName: "AWS::EC2::NetworkInterface",
  }]);

  assertEquals(result.truncatedTypes, ["AWS::EC2::NetworkInterface"]);
});

Deno.test("throttling is retried rather than treated as a hard failure", async () => {
  let attempts = 0;
  const client = stubClient(() => {
    attempts++;
    if (attempts < 3) {
      const error = new Error("Rate exceeded");
      error.name = "ThrottlingException";
      throw error;
    }
    return { ResourceDescriptions: described(["vpc-1"]) };
  });

  const outcome = await listResources(client, { typeName: "AWS::EC2::VPC" });

  assertEquals(attempts, 3);
  assertEquals(outcome.resources.length, 1);
});

Deno.test("a bare 'Rate exceeded' message counts as throttling", () => {
  // CloudControl returns this without a recognisable exception name; treating
  // it as permanent aborted a whole discovery run during development.
  const error = new Error("Rate exceeded");
  assert(!isTolerableListError(error));
});

Deno.test("permission and capability errors are tolerated, not fatal", () => {
  const denied = new Error("User is not authorized to perform this action");
  denied.name = "AccessDeniedException";
  assert(isTolerableListError(denied));

  const unsupported = new Error("does not support LIST action");
  assert(isTolerableListError(unsupported));
});

Deno.test("hydration absorbs an AWS read failure and keeps the listed resource", async () => {
  const client = stubClient(() => {
    const error = new Error("User is not authorized to perform this action");
    error.name = "AccessDeniedException";
    throw error;
  });
  const resources = [{
    type: "AWS::EC2::VPC",
    identifier: "vpc-1",
    properties: { VpcId: "vpc-1" },
  }];

  const errors = await hydrateResources(client, resources, ["AWS::EC2::VPC"]);

  assertEquals(errors.length, 1);
  // The resource survives with whatever listing gave us.
  assertEquals(resources[0].properties, { VpcId: "vpc-1" });
});

Deno.test("hydration rethrows a bug instead of recording it as a read failure", async () => {
  // Absorbing this would turn a broken loop into a green run reporting hundreds
  // of per-resource "errors".
  const client = stubClient(() => {
    throw new TypeError("cannot read properties of undefined");
  });
  const resources = [{
    type: "AWS::EC2::VPC",
    identifier: "vpc-1",
    properties: {},
  }];

  await assertRejects(
    () => hydrateResources(client, resources, ["AWS::EC2::VPC"]),
    TypeError,
  );
});

Deno.test("programmer errors are distinguished from operational ones", () => {
  assert(isProgrammerError(new TypeError("boom")));
  assert(isProgrammerError(new ReferenceError("boom")));
  assert(!isProgrammerError(new Error("Rate exceeded")));

  const denied = new Error("denied");
  denied.name = "AccessDeniedException";
  assert(!isProgrammerError(denied));
});

Deno.test("region resolution prefers the explicit argument", () => {
  assertEquals(resolveRegion("eu-west-1", { region: "us-east-1" }), "eu-west-1");
  assertEquals(resolveRegion(undefined, { region: "us-east-1" }), "us-east-1");
});

Deno.test("credentials are only built when both halves are present", () => {
  assertEquals(
    buildCredentials({ accessKeyId: "AKIA", secretAccessKey: "s", extra: 1 }),
    { accessKeyId: "AKIA", secretAccessKey: "s", sessionToken: undefined },
  );
  // Nothing configured: fall through to the AWS credential chain.
  assertEquals(buildCredentials({}), {
    accessKeyId: undefined,
    secretAccessKey: undefined,
    sessionToken: undefined,
  });
});
