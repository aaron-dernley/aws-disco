import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./architecture_diagram.ts";
import {
  buildGraph,
  buildTagFacets,
  collectTags,
  type GraphNode,
  type RawInventory,
  type RawResource,
} from "./_lib/topology_graph.ts";
import { renderDiagram } from "./_lib/diagram_template.ts";

/** A bare node carrying just the tags a facet test needs. */
function taggedNode(id: string, tags: Record<string, string>): GraphNode {
  return {
    id,
    kind: "EC2 instance",
    label: id,
    sub: "",
    category: "instance",
    group: "grp:x",
    detail: [],
    tags,
  };
}

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

Deno.test("every drawn object says what kind of thing it is", () => {
  const edge = inventory("edge", [
    res("AWS::ElasticLoadBalancingV2::LoadBalancer", "arn:lb", {
      LoadBalancerArn: "arn:lb",
      Name: "public-nlb",
      Type: "network",
      Scheme: "internet-facing",
      Subnets: ["subnet-pub"],
    }),
    res("AWS::ElasticLoadBalancingV2::TargetGroup", "arn:tg", {
      TargetGroupArn: "arn:tg",
      Name: "tg",
      Port: 8080,
    }),
  ]);
  const compute = inventory("compute", [
    res("AWS::EC2::Instance", "i-1", { InstanceId: "i-1", SubnetId: "subnet-prv" }),
  ]);

  const graph = buildGraph([baseNetwork(), edge, compute], "eu-west-2");
  const kindOf = (id: string) => graph.nodes.find((n) => n.id === id)?.kind;

  assertEquals(kindOf("ec2:i-1"), "EC2 instance");
  assertEquals(kindOf("igw:igw-1"), "Internet gateway");
  assertEquals(kindOf("nat:nat-1"), "NAT gateway");
  assertEquals(kindOf("tg:arn:tg"), "Target group");
  assertEquals(kindOf("elb:arn:lb"), "NLB", "the flavour of balancer matters");
  assertEquals(kindOf("net:internet"), "External");

  for (const node of graph.nodes) {
    assert(node.kind, `${node.id} has no kind`);
  }
});

Deno.test("a long name reaches the browser whole, for the inspect pane to show", () => {
  // The tile truncates at render time against its own width; truncating here
  // instead would mean the inspect pane could never show the real name.
  const longName = "data-integration-worker-blue-staging-eu-west-2-01";
  const compute = inventory("compute", [
    res("AWS::EC2::Instance", "i-1", {
      InstanceId: "i-1",
      SubnetId: "subnet-prv",
      Tags: [{ Key: "Name", Value: longName }],
    }),
  ]);

  const graph = buildGraph([baseNetwork(), compute], "eu-west-2");
  const node = graph.nodes.find((n) => n.id === "ec2:i-1");

  assertEquals(node?.label, longName);
  assert(!node?.label.includes("…"), "no pre-truncation in the graph data");
});

Deno.test("tags are read from every shape CloudControl returns them in", () => {
  // EC2 and ELBv2 return [{Key, Value}], Lambda and EKS return a plain map, and
  // a few services lowercase the entry keys. Missing any of these would leave
  // whole resource types silently unfilterable.
  assertEquals(
    collectTags({ Tags: [{ Key: "Environment", Value: "prod" }] }),
    { Environment: "prod" },
  );
  assertEquals(
    collectTags({ Tags: [{ key: "Environment", value: "prod" }] }),
    { Environment: "prod" },
  );
  assertEquals(
    collectTags({ Tags: { Environment: "prod" } }),
    { Environment: "prod" },
  );
  assertEquals(collectTags({ tags: { Service: "api" } }), { Service: "api" });
  assertEquals(collectTags({}), {});
  // AWS accepts these as tag keys; a plain object would either swallow the
  // assignment or hand back something inherited from Object.prototype.
  assertEquals(collectTags({ Tags: [{ Key: "__proto__", Value: "x" }] }), {});
  assertEquals(
    Object.keys(collectTags({ Tags: [{ Key: "constructor", Value: "x" }] })),
    ["constructor"],
  );
  // An empty value is legal in AWS but matches nothing useful as a filter.
  assertEquals(collectTags({ Tags: [{ Key: "Environment", Value: "" }] }), {});
});

Deno.test("tag facets rank the keys people actually slice an estate by", () => {
  const nodes = [
    taggedNode("a", { Owner: "platform", environment: "prod", app: "web" }),
    taggedNode("b", { Owner: "platform", environment: "prod", app: "web" }),
    taggedNode("c", { Owner: "data", environment: "dev", app: "etl" }),
  ];

  const keys = buildTagFacets(nodes).map((f) => f.key);
  assertEquals(keys, ["environment", "app", "Owner"]);
});

Deno.test("a tag key that never repeats a value is not offered as a filter", () => {
  // `Name` and CloudFormation's logical id identify one resource each, so
  // filtering on them can only ever leave a single object on the canvas.
  const nodes = ["a", "b", "c", "d", "e", "f"].map((id) =>
    taggedNode(id, {
      Name: "server-" + id,
      "aws:cloudformation:stack-name": "core",
      Environment: "prod",
    })
  );

  const keys = buildTagFacets(nodes).map((f) => f.key);
  assertEquals(keys.includes("Name"), false);
  assert(keys.includes("Environment"));
  assert(
    keys.includes("aws:cloudformation:stack-name"),
    "a shared stack name is a legitimate slice",
  );
});

Deno.test("facet values are counted and ordered by how much they cover", () => {
  const nodes = [
    taggedNode("a", { Environment: "prod" }),
    taggedNode("b", { Environment: "prod" }),
    taggedNode("c", { Environment: "dev" }),
    taggedNode("d", {}),
  ];

  const [environment] = buildTagFacets(nodes);
  assertEquals(environment.taggedCount, 3);
  assertEquals(environment.values, [
    { value: "prod", count: 2 },
    { value: "dev", count: 1 },
  ]);
});

Deno.test("discovered resources carry their tags onto the drawn node", () => {
  const compute = inventory("compute", [
    res("AWS::EC2::Instance", "i-1", {
      InstanceId: "i-1",
      SubnetId: "subnet-prv",
      Tags: [
        { Key: "Name", Value: "api-1" },
        { Key: "Environment", Value: "production" },
        { Key: "Service", Value: "checkout" },
      ],
    }),
  ]);

  const graph = buildGraph([baseNetwork(), compute], "eu-west-2");
  const node = graph.nodes.find((n) => n.id === "ec2:i-1");

  assertEquals(node?.tags.Environment, "production");
  assertEquals(node?.tags.Service, "checkout");
  assert(
    graph.tagFacets.some((f) => f.key === "Environment"),
    "Environment should be offered as a filter",
  );
});

Deno.test("the internet and PrivateLink actors are exempt from tag filtering", () => {
  // They are drawn rather than discovered, so they carry no tags. Filtering
  // them out would sever the inbound path of every environment they front.
  const graph = buildGraph([baseNetwork()], "eu-west-2");

  for (const id of ["net:internet", "net:aws-services"]) {
    const node = graph.nodes.find((n) => n.id === id);
    assertEquals(node?.alwaysVisible, true, `${id} must survive a tag filter`);
  }
  const gateway = graph.nodes.find((n) => n.id === "igw:igw-1");
  assert(!gateway?.alwaysVisible, "discovered objects are filterable");
});

Deno.test("an untagged estate still renders, with no tag facets", () => {
  const graph = buildGraph([baseNetwork()], "eu-west-2");
  assertEquals(graph.tagFacets, []);

  const html = renderDiagram(graph, { url: "https://example.test/d3.js" });
  assert(html.includes('data-tab="tags"'), "the tab is always present");
});

Deno.test("the rendered diagram ships the tag tab and its facet data", () => {
  const compute = inventory("compute", [
    res("AWS::EC2::Instance", "i-1", {
      InstanceId: "i-1",
      SubnetId: "subnet-prv",
      Tags: [{ Key: "Environment", Value: "production" }],
    }),
    res("AWS::EC2::Instance", "i-2", {
      InstanceId: "i-2",
      SubnetId: "subnet-prv",
      Tags: [{ Key: "Environment", Value: "production" }],
    }),
  ]);

  const graph = buildGraph([baseNetwork(), compute], "eu-west-2");
  const html = renderDiagram(graph, { url: "https://example.test/d3.js" });

  assert(html.includes('data-tab="tags"'));
  assert(html.includes('id="tagfilters"'));
  assert(html.includes("tagFacets"), "the facet payload must reach the browser");
  assert(html.includes("production"));
});

Deno.test("the embedded client script is syntactically valid JavaScript", () => {
  // The script lives in a String.raw template, where a stray ${...} would be
  // interpolated away at build time and only fail in someone's browser.
  const graph = buildGraph([baseNetwork()], "eu-west-2");
  const html = renderDiagram(graph, { url: "https://example.test/d3.js" });

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]);
  assert(scripts.length >= 2, "expected the payload and behaviour scripts");
  for (const source of scripts) {
    new Function(source);
  }
  assert(
    !html.includes("[object Object]") && !html.includes("undefined,"),
    "no template placeholder should have leaked into the output",
  );
});

Deno.test("the summary reports tag coverage so an untagged estate is visible", () => {
  const compute = inventory("compute", [
    res("AWS::EC2::Instance", "i-1", {
      InstanceId: "i-1",
      SubnetId: "subnet-prv",
      Tags: [{ Key: "Environment", Value: "production" }],
    }),
    res("AWS::EC2::Instance", "i-2", {
      InstanceId: "i-2",
      SubnetId: "subnet-prv",
      Tags: [{ Key: "Environment", Value: "staging" }],
    }),
  ]);
  const graph = buildGraph([baseNetwork(), compute], "eu-west-2");

  const tagKeys: Record<string, number> = {};
  for (const facet of graph.tagFacets) tagKeys[facet.key] = facet.taggedCount;
  assertEquals(tagKeys.Environment, 2);

  const untagged = graph.nodes.filter((n) =>
    !n.alwaysVisible && Object.keys(n.tags).length === 0
  ).length;
  assert(untagged > 0, "the untagged gateways should be counted");

  const parsed = model.resources.summary.schema.safeParse({
    region: "eu-west-2",
    generatedAt: graph.meta.generatedAt,
    nodeCount: graph.nodes.length,
    linkCount: graph.links.length,
    vpcCount: 1,
    subnetCount: 2,
    publicPathCount: 0,
    privatePathCount: 0,
    categories: {},
    pathTypes: {},
    tagKeys,
    untaggedNodeCount: untagged,
    publishedPath: "diagrams/aws-architecture-eu-west-2.html",
    d3Embedded: true,
    freshDomainCount: 2,
    staleDomains: [],
    warnings: [],
  });
  assert(parsed.success, JSON.stringify(parsed.error?.issues));
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
