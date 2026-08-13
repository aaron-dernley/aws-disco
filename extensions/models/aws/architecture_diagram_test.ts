import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./architecture_diagram.ts";
import {
  buildGraph,
  type RawInventory,
  type RawResource,
} from "./_lib/topology_graph.ts";

function res(
  type: string,
  identifier: string,
  properties: Record<string, unknown> = {},
): RawResource {
  return { type, identifier, properties };
}

function inventory(
  domain: string,
  resources: RawResource[],
  discoveredAt = new Date().toISOString(),
): RawInventory {
  return { domain, region: "eu-west-2", discoveredAt, resources, errors: [] };
}

/** A VPC with one public and one private subnet, wired through route tables. */
function baseNetwork(extra: RawResource[] = []): RawInventory {
  return inventory("network", [
    res("AWS::EC2::VPC", "vpc-1", { VpcId: "vpc-1", CidrBlock: "192.0.2.0/24" }),
    res("AWS::EC2::Subnet", "subnet-pub", {
      SubnetId: "subnet-pub",
      VpcId: "vpc-1",
      CidrBlock: "192.0.2.0/25",
      AvailabilityZone: "eu-west-2a",
    }),
    res("AWS::EC2::Subnet", "subnet-prv", {
      SubnetId: "subnet-prv",
      VpcId: "vpc-1",
      CidrBlock: "192.0.2.128/25",
      AvailabilityZone: "eu-west-2a",
    }),
    res("AWS::EC2::RouteTable", "rtb-pub", {
      RouteTableId: "rtb-pub",
      VpcId: "vpc-1",
    }),
    res("AWS::EC2::RouteTable", "rtb-prv", {
      RouteTableId: "rtb-prv",
      VpcId: "vpc-1",
    }),
    res("AWS::EC2::SubnetRouteTableAssociation", "a1", {
      SubnetId: "subnet-pub",
      RouteTableId: "rtb-pub",
    }),
    res("AWS::EC2::SubnetRouteTableAssociation", "a2", {
      SubnetId: "subnet-prv",
      RouteTableId: "rtb-prv",
    }),
    res("AWS::EC2::Route", "r1", {
      RouteTableId: "rtb-pub",
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: "igw-1",
    }),
    res("AWS::EC2::Route", "r2", {
      RouteTableId: "rtb-prv",
      DestinationCidrBlock: "0.0.0.0/0",
      NatGatewayId: "nat-1",
    }),
    res("AWS::EC2::InternetGateway", "igw-1", { InternetGatewayId: "igw-1" }),
    res("AWS::EC2::VPCGatewayAttachment", "att-1", {
      InternetGatewayId: "igw-1",
      VpcId: "vpc-1",
    }),
    res("AWS::EC2::NatGateway", "nat-1", {
      NatGatewayId: "nat-1",
      SubnetId: "subnet-pub",
      VpcId: "vpc-1",
    }),
    ...extra,
  ]);
}

Deno.test("a subnet is public only when its route table reaches an internet gateway", () => {
  const graph = buildGraph([baseNetwork()], "eu-west-2");

  const pub = graph.groups.find((g) => g.id === "grp:subnet-pub");
  const prv = graph.groups.find((g) => g.id === "grp:subnet-prv");
  assert(pub?.sub.includes("public"), `expected public, got ${pub?.sub}`);
  assert(prv?.sub.includes("private"), `expected private, got ${prv?.sub}`);
});

Deno.test("MapPublicIpOnLaunch alone does not make a subnet public", () => {
  // A subnet can hand out public IPs and still have no route off the VPC.
  const network = inventory("network", [
    res("AWS::EC2::VPC", "vpc-1", { VpcId: "vpc-1", CidrBlock: "192.0.2.0/24" }),
    res("AWS::EC2::Subnet", "subnet-x", {
      SubnetId: "subnet-x",
      VpcId: "vpc-1",
      CidrBlock: "198.51.100.0/24",
      MapPublicIpOnLaunch: true,
    }),
  ]);

  const graph = buildGraph([network], "eu-west-2");
  const subnet = graph.groups.find((g) => g.id === "grp:subnet-x");
  assert(subnet?.sub.includes("private"));
});

Deno.test("an internet-facing load balancer gets an inbound path from the gateway", () => {
  // Regression: the ELBv2 CloudControl schema carries no VpcId, so the VPC has
  // to be resolved through the balancer's subnets. Without that, every
  // internet-facing balancer was drawn with no way in.
  const edge = inventory("edge", [
    res("AWS::ElasticLoadBalancingV2::LoadBalancer", "arn:lb", {
      LoadBalancerArn: "arn:lb",
      Name: "public-alb",
      Scheme: "internet-facing",
      Subnets: ["subnet-pub"],
      // deliberately no VpcId — matches what AWS actually returns
    }),
  ]);

  const graph = buildGraph([baseNetwork(), edge], "eu-west-2");

  const inbound = graph.links.filter((l) =>
    l.pathType === "ingress" && l.source === "igw:igw-1" &&
    l.target === "elb:arn:lb"
  );
  assertEquals(inbound.length, 1, "expected igw -> internet-facing LB");
});

Deno.test("an internal load balancer gets no inbound internet path", () => {
  const edge = inventory("edge", [
    res("AWS::ElasticLoadBalancingV2::LoadBalancer", "arn:lb", {
      LoadBalancerArn: "arn:lb",
      Name: "internal-alb",
      Scheme: "internal",
      Subnets: ["subnet-prv"],
    }),
  ]);

  const graph = buildGraph([baseNetwork(), edge], "eu-west-2");
  const inbound = graph.links.filter((l) =>
    l.pathType === "ingress" && l.target === "elb:arn:lb"
  );
  assertEquals(inbound, []);
});

Deno.test("target groups link to instances even though compute is built later", () => {
  // Regression: target groups are processed before instance nodes exist, so
  // these edges were silently dropped by addLink's endpoint check.
  const edge = inventory("edge", [
    res("AWS::ElasticLoadBalancingV2::TargetGroup", "arn:tg", {
      TargetGroupArn: "arn:tg",
      Name: "tg",
      Port: 8080,
      VpcId: "vpc-1",
      Targets: [{ Id: "i-123", Port: 8080 }],
    }),
  ]);
  const compute = inventory("compute", [
    res("AWS::EC2::Instance", "i-123", {
      InstanceId: "i-123",
      SubnetId: "subnet-prv",
      VpcId: "vpc-1",
      PrivateIp: "192.0.2.130",
    }),
  ]);

  const graph = buildGraph([baseNetwork(), edge, compute], "eu-west-2");

  const forward = graph.links.filter((l) =>
    l.source === "tg:arn:tg" && l.target === "ec2:i-123"
  );
  assertEquals(forward.length, 1, "expected target group -> instance");
});

Deno.test("an IP target resolves to the instance holding that private IP", () => {
  const edge = inventory("edge", [
    res("AWS::ElasticLoadBalancingV2::TargetGroup", "arn:tg", {
      TargetGroupArn: "arn:tg",
      Name: "tg",
      Port: 443,
      Targets: [{ Id: "192.0.2.130", Port: 443 }],
    }),
  ]);
  const compute = inventory("compute", [
    res("AWS::EC2::Instance", "i-123", {
      InstanceId: "i-123",
      SubnetId: "subnet-prv",
      PrivateIp: "192.0.2.130",
    }),
  ]);

  const graph = buildGraph([baseNetwork(), edge, compute], "eu-west-2");
  assert(
    graph.links.some((l) =>
      l.source === "tg:arn:tg" && l.target === "ec2:i-123"
    ),
  );
});

Deno.test("egress is read from real routes: private subnet exits via NAT", () => {
  const compute = inventory("compute", [
    res("AWS::EC2::Instance", "i-private", {
      InstanceId: "i-private",
      SubnetId: "subnet-prv",
      VpcId: "vpc-1",
    }),
    res("AWS::EC2::Instance", "i-public", {
      InstanceId: "i-public",
      SubnetId: "subnet-pub",
      VpcId: "vpc-1",
    }),
  ]);

  const graph = buildGraph([baseNetwork(), compute], "eu-west-2");

  assert(
    graph.links.some((l) =>
      l.source === "ec2:i-private" && l.target === "nat:nat-1" &&
      l.pathType === "egress-nat"
    ),
    "private instance should egress via NAT",
  );
  assert(
    graph.links.some((l) =>
      l.source === "ec2:i-public" && l.target === "igw:igw-1" &&
      l.pathType === "egress-igw"
    ),
    "public instance should egress straight out of the gateway",
  );
});

Deno.test("public and private paths are scoped so the viewer can filter them", () => {
  const graph = buildGraph([baseNetwork()], "eu-west-2");
  const scopes = new Set(graph.links.map((l) => l.scope));
  for (const scope of scopes) assert(scope === "public" || scope === "private");

  const endpointPaths = graph.pathTypes.find((p) => p.key === "endpoint");
  assertEquals(endpointPaths?.scope, "private");
});

Deno.test("a stale inventory is reported, not silently drawn as current", () => {
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const graph = buildGraph(
    [inventory("network", baseNetwork().resources ?? [], old)],
    "eu-west-2",
    360,
  );

  assert(graph.meta.staleDomains.includes("network"));
  assert(graph.meta.warnings.some((w) => w.includes("did not refresh")));
});

Deno.test("a domain that never ran counts as stale, not merely missing", () => {
  // Ageing alone can't see an absent domain, which would leave the workflow's
  // freshness assert green while the diagram silently omitted a whole domain.
  const graph = buildGraph([baseNetwork()], "eu-west-2");

  for (const missing of ["compute", "workloads", "edge"]) {
    assert(
      graph.meta.staleDomains.includes(missing),
      `${missing} should be stale`,
    );
  }
  assert(!graph.meta.staleDomains.includes("network"));
});

Deno.test("a fresh, complete run reports nothing stale", () => {
  const graph = buildGraph([
    baseNetwork(),
    inventory("compute", []),
    inventory("workloads", []),
    inventory("edge", []),
  ], "eu-west-2");

  assertEquals(graph.meta.staleDomains, []);
});

Deno.test("a truncated listing is surfaced, not passed off as complete", () => {
  const capped: RawInventory = {
    ...baseNetwork(),
    truncated: true,
    truncatedTypes: ["AWS::EC2::NetworkInterface"],
  };

  const graph = buildGraph([capped], "eu-west-2");

  assert(
    graph.meta.warnings.some((w) =>
      w.includes("AWS::EC2::NetworkInterface") && w.includes("pagination")
    ),
    "a capped type must be reported in the diagram warnings",
  );
});

Deno.test("every link points at a node that exists", () => {
  const compute = inventory("compute", [
    res("AWS::EC2::Instance", "i-1", {
      InstanceId: "i-1",
      SubnetId: "subnet-prv",
    }),
  ]);
  const graph = buildGraph([baseNetwork(), compute], "eu-west-2");

  const ids = new Set(graph.nodes.map((n) => n.id));
  const dangling = graph.links.filter((l) =>
    !ids.has(l.source) || !ids.has(l.target)
  );
  assertEquals(dangling, []);
});

Deno.test("every node sits inside a declared boundary", () => {
  const graph = buildGraph([baseNetwork()], "eu-west-2");
  const groups = new Set(graph.groups.map((g) => g.id));
  const orphans = graph.nodes.filter((n) => !groups.has(n.group));
  assertEquals(orphans, []);
});

Deno.test("an empty region still produces a renderable graph", () => {
  const graph = buildGraph([inventory("network", [])], "eu-west-2");

  assertEquals(graph.meta.region, "eu-west-2");
  assert(graph.nodes.length > 0, "external actors are always drawn");
  assertEquals(graph.links.length, 0);
});

Deno.test("the model declares the file and resource outputs the workflow reads", () => {
  assertEquals(model.type, "@aaronge/aws-architecture-diagram");
  assertEquals(model.files.html.contentType, "text/html");
  assert("summary" in model.resources);
});

Deno.test("inventory global arguments accept null so a missing domain degrades", () => {
  // `data.latest(...).?attributes` resolves to null when a domain has no data;
  // rejecting null here would fail the render instead of noting the gap.
  const parsed = model.globalArguments.safeParse({
    region: "eu-west-2",
    network: null,
    compute: null,
    workloads: null,
    edge: null,
  });
  assert(parsed.success, JSON.stringify(parsed.error?.issues));
});
