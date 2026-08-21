// Turns the four domain inventories into the node/link/group graph the D3
// diagram renders.
//
// The shape of the output is deliberately presentation-agnostic: boundaries
// (region, VPC, subnet) are `groups`, everything drawn as a box is a `node`, and
// every line is a `link` carrying a path type and a public/private scope so the
// viewer can filter by traffic class.
//
// @module

/** One resource as captured by a discovery run. */
export interface RawResource {
  type: string;
  identifier: string;
  properties: Record<string, unknown>;
}

/** One domain inventory produced by a `discover` method. */
export interface RawInventory {
  domain?: string;
  region?: string;
  discoveredAt?: string;
  resources?: RawResource[];
  counts?: Record<string, number>;
  errors?: { type: string; message: string }[];
  truncated?: boolean;
  truncatedTypes?: string[];
}

/** A drawn box: compute, gateway, balancer or external actor. */
export interface GraphNode {
  id: string;
  /** What kind of thing this is — the bold first line of the drawn tile. */
  kind: string;
  label: string;
  sub: string;
  category: string;
  group: string;
  vpc?: string;
  detail: [string, string][];
  /** Resource tags, normalised to a flat map, used by the tag filter. */
  tags: Record<string, string>;
  /**
   * Exempt from tag filtering. The internet and PrivateLink actors are drawn by
   * this renderer rather than discovered, so they carry no tags — filtering them
   * out would sever the inbound path of every environment they front.
   */
  alwaysVisible?: boolean;
}

/** A drawn line between two nodes. */
export interface GraphLink {
  id: string;
  source: string;
  target: string;
  pathType: string;
  scope: "public" | "private";
  label: string;
}

/** One tag key and the values it takes across the estate, for the filter rail. */
export interface TagFacet {
  key: string;
  /** How many nodes carry this key. */
  taggedCount: number;
  values: { value: string; count: number }[];
}

/** A boundary box that contains nodes. */
export interface GraphGroup {
  id: string;
  label: string;
  sub: string;
  kind: "vpc" | "subnet" | "external";
  parent: string;
}

/** The complete graph handed to the browser. */
export interface TopologyGraph {
  meta: {
    region: string;
    generatedAt: string;
    accountHint: string;
    domains: {
      domain: string;
      discoveredAt: string;
      resourceCount: number;
      ageMinutes: number;
      stale: boolean;
    }[];
    staleDomains: string[];
    warnings: string[];
  };
  groups: GraphGroup[];
  nodes: GraphNode[];
  links: GraphLink[];
  categories: { key: string; label: string; colour: string }[];
  pathTypes: { key: string; label: string; scope: string }[];
  /** Tag keys worth filtering on, most useful first. */
  tagFacets: TagFacet[];
}

/** Node categories, in left-rail display order. */
export const CATEGORIES: { key: string; label: string; colour: string }[] = [
  { key: "external", label: "Internet / external", colour: "#f2a65a" },
  { key: "gateway", label: "Internet gateway", colour: "#f2a65a" },
  { key: "balancer", label: "Load balancer", colour: "#4cc9f0" },
  { key: "nat", label: "NAT gateway", colour: "#f7b267" },
  { key: "endpoint", label: "VPC endpoint", colour: "#7ee787" },
  { key: "peering", label: "Peering / transit", colour: "#c792ea" },
  { key: "instance", label: "EC2 instance", colour: "#7ee787" },
  { key: "asg", label: "Auto scaling group", colour: "#56d364" },
  { key: "ecs", label: "ECS service", colour: "#4cc9f0" },
  { key: "eks", label: "EKS cluster / nodes", colour: "#58a6ff" },
  { key: "lambda", label: "Lambda function", colour: "#d2a8ff" },
  { key: "targetgroup", label: "Target group", colour: "#8b949e" },
];

/** Link path types, in left-rail display order. */
export const PATH_TYPES: { key: string; label: string; scope: string }[] = [
  { key: "ingress", label: "Inbound / internet", scope: "public" },
  { key: "forward", label: "Listener → target", scope: "private" },
  { key: "member", label: "Group membership", scope: "private" },
  { key: "egress-nat", label: "Outbound via NAT", scope: "public" },
  { key: "egress-igw", label: "Outbound direct", scope: "public" },
  { key: "endpoint", label: "Private AWS service", scope: "private" },
  { key: "peering", label: "VPC peering", scope: "private" },
  { key: "transit", label: "Transit / VPN", scope: "private" },
];

const INTERNET_ID = "net:internet";
const AWS_SERVICES_ID = "net:aws-services";
const ONPREM_ID = "net:on-premises";
const EXTERNAL_GROUP = "grp:external";
const UNPLACED_GROUP = "grp:unplaced";

type Props = Record<string, unknown>;

function str(props: Props, key: string): string | undefined {
  const value = props[key];
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function arr(props: Props, key: string): unknown[] {
  const value = props[key];
  return Array.isArray(value) ? value : [];
}

function obj(props: Props, key: string): Props | undefined {
  const value = props[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Props
    : undefined;
}

function strings(props: Props, key: string): string[] {
  return arr(props, key).filter((v): v is string => typeof v === "string");
}

/**
 * Tag keys that name a single resource rather than describe a slice of the
 * estate. Offering them as filters is noise: every value matches one object.
 */
const UNFILTERABLE_TAG_KEYS = new Set([
  "Name",
  "aws:cloudformation:logical-id",
  "aws:cloudformation:stack-id",
  "aws:ecs:serviceName",
  "aws:autoscaling:groupName",
  "eks:nodegroup-name",
]);

/**
 * Tag keys that carve the estate into the slices people actually ask for, in
 * the order they should appear. Matched loosely because naming conventions
 * differ per account — `Environment`, `env`, `tf_environment` all count.
 */
const TAG_KEY_PRIORITY: RegExp[] = [
  /env/i,
  /stage/i,
  /service/i,
  /\bapp/i,
  /component/i,
  /workload/i,
  /product/i,
  /project/i,
  /team/i,
  /owner/i,
  /tier/i,
  /stack/i,
  /role/i,
];

/**
 * Normalise a resource's tags into a flat map.
 *
 * CloudControl is not consistent about tag shape: EC2 and ELBv2 return
 * `[{Key, Value}]`, Lambda and EKS return a plain `{key: value}` object, and a
 * few services lowercase the entry keys. All three are accepted so a tag filter
 * doesn't silently miss whole resource types.
 */
export function collectTags(props: Props): Record<string, string> {
  const tags: Record<string, string> = {};
  const raw = props.Tags ?? props.tags;
  // `__proto__` is a legal AWS tag key and assigning it would either be
  // swallowed or reshape the object. Drop it deliberately instead.
  const usable = (key: string): boolean => key !== "__proto__";

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Props;
      const key = typeof item.Key === "string"
        ? item.Key
        : typeof item.key === "string"
        ? item.key
        : undefined;
      const value = typeof item.Value === "string"
        ? item.Value
        : typeof item.value === "string"
        ? item.value
        : undefined;
      // An empty value is legal in AWS but useless as a filter.
      if (key && value && usable(key)) tags[key] = value;
    }
    return tags;
  }

  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Props)) {
      if (typeof value === "string" && value && usable(key)) tags[key] = value;
    }
  }
  return tags;
}

/**
 * Summarise the tags across every node into the facets the filter rail offers.
 *
 * Keys whose values are all distinct are dropped: a key that never repeats
 * identifies resources instead of grouping them, so filtering on it can only
 * ever leave one object on the canvas.
 */
export function buildTagFacets(nodes: GraphNode[]): TagFacet[] {
  const byKey = new Map<string, Map<string, number>>();
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node.tags)) {
      let values = byKey.get(key);
      if (!values) {
        values = new Map();
        byKey.set(key, values);
      }
      values.set(value, (values.get(value) ?? 0) + 1);
    }
  }

  const facets: TagFacet[] = [];
  for (const [key, values] of byKey) {
    if (UNFILTERABLE_TAG_KEYS.has(key)) continue;
    let taggedCount = 0;
    for (const count of values.values()) taggedCount += count;
    // Tolerate a couple of one-offs before writing a key off as an identifier;
    // a small estate can legitimately have one resource per environment.
    if (values.size === taggedCount && taggedCount > 4) continue;
    facets.push({
      key,
      taggedCount,
      values: [...values.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    });
  }

  const rank = (key: string): number => {
    const index = TAG_KEY_PRIORITY.findIndex((pattern) => pattern.test(key));
    return index === -1 ? TAG_KEY_PRIORITY.length : index;
  };
  return facets.sort((a, b) =>
    rank(a.key) - rank(b.key) ||
    b.taggedCount - a.taggedCount ||
    a.key.localeCompare(b.key)
  );
}

/** The short name people use for each flavour of ELBv2. */
function lbKind(type: string | undefined): string {
  if (type === "network") return "NLB";
  if (type === "gateway") return "Gateway LB";
  return "ALB";
}

/** Pull the `Name` tag, falling back to the identifier's tail. */
function tagName(props: Props, fallback: string): string {
  for (const tag of arr(props, "Tags")) {
    if (!tag || typeof tag !== "object") continue;
    const entry = tag as Props;
    if (
      entry.Key === "Name" && typeof entry.Value === "string" && entry.Value
    ) {
      return entry.Value;
    }
  }
  return fallback;
}

/** Last segment of an ARN or slash-delimited identifier. */
function tail(value: string): string {
  const parts = value.split(/[/:]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : value;
}

/** Index resources by type for repeated lookup. */
function byType(inventories: RawInventory[]): Map<string, RawResource[]> {
  const index = new Map<string, RawResource[]>();
  for (const inventory of inventories) {
    for (const resource of inventory.resources ?? []) {
      const bucket = index.get(resource.type);
      if (bucket) bucket.push(resource);
      else index.set(resource.type, [resource]);
    }
  }
  return index;
}

/**
 * Build the topology graph from the discovery inventories.
 *
 * Missing domains are tolerated — a run that only discovered the network still
 * produces a usable diagram, with the gap recorded in `meta.warnings`.
 */
export function buildGraph(
  inventories: RawInventory[],
  region: string,
  maxAgeMinutes = 360,
): TopologyGraph {
  const present = inventories.filter((inventory) =>
    Array.isArray(inventory.resources)
  );
  const index = byType(present);
  const get = (type: string): RawResource[] => index.get(type) ?? [];

  const groups: GraphGroup[] = [];
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const warnings: string[] = [];
  const nodeIds = new Set<string>();
  const linkIds = new Set<string>();

  /**
   * Add a node, deriving its tags from the resource it came from. Nodes this
   * renderer invents rather than discovers pass no properties and end up
   * untagged.
   */
  const addNode = (node: Omit<GraphNode, "tags">, props?: Props): void => {
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push({ ...node, tags: props ? collectTags(props) : {} });
  };

  // Links whose endpoints are created later in the build; flushed once every
  // node exists.
  const deferred: (() => void)[] = [];
  /** Private IP -> the node that owns it, for resolving IP-type LB targets. */
  const privateIpOwner = new Map<string, string>();

  const addLink = (
    source: string,
    target: string,
    pathType: string,
    scope: "public" | "private",
    label = "",
  ): void => {
    if (source === target) return;
    if (!nodeIds.has(source) || !nodeIds.has(target)) return;
    const id = `${source}->${target}:${pathType}:${label}`;
    if (linkIds.has(id)) return;
    linkIds.add(id);
    links.push({ id, source, target, pathType, scope, label });
  };

  // ---- boundaries -------------------------------------------------------

  groups.push({
    id: EXTERNAL_GROUP,
    label: "EXTERNAL",
    sub: "outside the region",
    kind: "external",
    parent: "",
  });

  const vpcCidr = new Map<string, string>();
  for (const vpc of get("AWS::EC2::VPC")) {
    const id = str(vpc.properties, "VpcId") ?? vpc.identifier;
    const cidr = str(vpc.properties, "CidrBlock") ?? "";
    vpcCidr.set(id, cidr);
    groups.push({
      id: `grp:${id}`,
      label: tagName(vpc.properties, id),
      sub: cidr ? `${id} · ${cidr}` : id,
      kind: "vpc",
      parent: "",
    });
  }

  /** subnetId -> its route table, used to classify public vs private. */
  const subnetRouteTable = new Map<string, string>();
  for (const assoc of get("AWS::EC2::SubnetRouteTableAssociation")) {
    const subnetId = str(assoc.properties, "SubnetId");
    const routeTableId = str(assoc.properties, "RouteTableId");
    if (subnetId && routeTableId) subnetRouteTable.set(subnetId, routeTableId);
  }

  /** routeTableId -> its routes. */
  const routesByTable = new Map<string, Props[]>();
  for (const route of get("AWS::EC2::Route")) {
    const routeTableId = str(route.properties, "RouteTableId");
    if (!routeTableId) continue;
    const bucket = routesByTable.get(routeTableId);
    if (bucket) bucket.push(route.properties);
    else routesByTable.set(routeTableId, [route.properties]);
  }

  const routeTableVpc = new Map<string, string>();
  const mainTableForVpc = new Map<string, string>();
  for (const table of get("AWS::EC2::RouteTable")) {
    const tableId = str(table.properties, "RouteTableId") ?? table.identifier;
    const vpcId = str(table.properties, "VpcId");
    if (vpcId) {
      routeTableVpc.set(tableId, vpcId);
      if (!mainTableForVpc.has(vpcId)) mainTableForVpc.set(vpcId, tableId);
    }
  }

  /** Resolve the route table governing a subnet, falling back to the VPC's. */
  const tableForSubnet = (
    subnetId: string,
    vpcId: string,
  ): string | undefined =>
    subnetRouteTable.get(subnetId) ?? mainTableForVpc.get(vpcId);

  const subnetVpc = new Map<string, string>();
  const subnetIsPublic = new Map<string, boolean>();
  const subnetGroup = new Map<string, string>();

  for (const subnet of get("AWS::EC2::Subnet")) {
    const subnetId = str(subnet.properties, "SubnetId") ?? subnet.identifier;
    const vpcId = str(subnet.properties, "VpcId") ?? "";
    const cidr = str(subnet.properties, "CidrBlock") ?? "";
    const az = str(subnet.properties, "AvailabilityZone") ?? "";
    subnetVpc.set(subnetId, vpcId);

    // A subnet is public when its route table sends the default route at an
    // internet gateway; MapPublicIpOnLaunch alone doesn't make it reachable.
    const tableId = tableForSubnet(subnetId, vpcId);
    const routes = tableId ? routesByTable.get(tableId) ?? [] : [];
    const isPublic = routes.some((route) =>
      (str(route, "GatewayId") ?? "").startsWith("igw-")
    );
    subnetIsPublic.set(subnetId, isPublic);

    const groupId = `grp:${subnetId}`;
    subnetGroup.set(subnetId, groupId);
    groups.push({
      id: groupId,
      label: tagName(subnet.properties, subnetId),
      sub: `${az || "?"} · ${cidr} · ${isPublic ? "public" : "private"}`,
      kind: "subnet",
      parent: vpcId ? `grp:${vpcId}` : "",
    });
  }

  groups.push({
    id: UNPLACED_GROUP,
    label: "REGIONAL / NO VPC",
    sub: "not attached to a subnet",
    kind: "external",
    parent: "",
  });

  /** Choose the tightest boundary a resource belongs in. */
  const placement = (subnetId?: string, vpcId?: string): string => {
    if (subnetId && subnetGroup.has(subnetId)) {
      return subnetGroup.get(subnetId)!;
    }
    if (vpcId && vpcCidr.has(vpcId)) return `grp:${vpcId}`;
    return UNPLACED_GROUP;
  };

  // ---- external actors --------------------------------------------------

  addNode({
    id: INTERNET_ID,
    kind: "External",
    label: "INTERNET",
    sub: "0.0.0.0/0",
    category: "external",
    group: EXTERNAL_GROUP,
    alwaysVisible: true,
    detail: [["Scope", "Public internet"], ["CIDR", "0.0.0.0/0"]],
  });
  addNode({
    id: AWS_SERVICES_ID,
    kind: "External",
    label: "AWS SERVICES",
    sub: "via PrivateLink",
    category: "external",
    group: EXTERNAL_GROUP,
    alwaysVisible: true,
    detail: [["Scope", "AWS service endpoints"], ["Path", "Private, no IGW"]],
  });

  // ---- network fabric ---------------------------------------------------

  const igwVpc = new Map<string, string>();
  for (const attachment of get("AWS::EC2::VPCGatewayAttachment")) {
    const igwId = str(attachment.properties, "InternetGatewayId");
    const vpcId = str(attachment.properties, "VpcId");
    if (igwId && vpcId) igwVpc.set(igwId, vpcId);
  }

  for (const igw of get("AWS::EC2::InternetGateway")) {
    const igwId = str(igw.properties, "InternetGatewayId") ?? igw.identifier;
    const vpcId = igwVpc.get(igwId);
    addNode({
      id: `igw:${igwId}`,
      kind: "Internet gateway",
      label: tagName(igw.properties, igwId),
      sub: igwId,
      category: "gateway",
      group: placement(undefined, vpcId),
      vpc: vpcId,
      detail: [
        ["Type", "Internet gateway"],
        ["Gateway", igwId],
        ["VPC", vpcId ?? "unattached"],
      ],
    }, igw.properties);
    addLink(INTERNET_ID, `igw:${igwId}`, "ingress", "public", "inbound");
    addLink(`igw:${igwId}`, INTERNET_ID, "egress-igw", "public", "outbound");
  }

  const natSubnet = new Map<string, string>();
  for (const nat of get("AWS::EC2::NatGateway")) {
    const natId = str(nat.properties, "NatGatewayId") ?? nat.identifier;
    const subnetId = str(nat.properties, "SubnetId");
    const vpcId = str(nat.properties, "VpcId") ??
      (subnetId ? subnetVpc.get(subnetId) : undefined);
    if (subnetId) natSubnet.set(natId, subnetId);
    addNode({
      id: `nat:${natId}`,
      kind: "NAT gateway",
      label: tagName(nat.properties, natId),
      sub: str(nat.properties, "PrivateIpAddress") ?? natId,
      category: "nat",
      group: placement(subnetId, vpcId),
      vpc: vpcId,
      detail: [
        ["Type", "NAT gateway"],
        ["Gateway", natId],
        ["Connectivity", str(nat.properties, "ConnectivityType") ?? "public"],
        ["Subnet", subnetId ?? "—"],
      ],
    }, nat.properties);
    // A NAT's own egress leaves through its VPC's internet gateway.
    if (vpcId) {
      for (const [igwId, attachedVpc] of igwVpc) {
        if (attachedVpc === vpcId) {
          addLink(
            `nat:${natId}`,
            `igw:${igwId}`,
            "egress-nat",
            "public",
            "snat",
          );
        }
      }
    }
  }

  for (const endpoint of get("AWS::EC2::VPCEndpoint")) {
    const endpointId = str(endpoint.properties, "Id") ?? endpoint.identifier;
    const vpcId = str(endpoint.properties, "VpcId");
    const service = str(endpoint.properties, "ServiceName") ?? "";
    const subnetIds = strings(endpoint.properties, "SubnetIds");
    addNode({
      id: `vpce:${endpointId}`,
      kind: "VPC endpoint",
      label: tail(service) || endpointId,
      sub: str(endpoint.properties, "VpcEndpointType") ?? "Interface",
      category: "endpoint",
      group: placement(subnetIds[0], vpcId),
      vpc: vpcId,
      detail: [
        ["Type", "VPC endpoint"],
        ["Endpoint", endpointId],
        ["Service", service],
        ["Mode", str(endpoint.properties, "VpcEndpointType") ?? "Interface"],
        ["Subnets", subnetIds.length ? subnetIds.join(", ") : "gateway type"],
      ],
    }, endpoint.properties);
    addLink(
      `vpce:${endpointId}`,
      AWS_SERVICES_ID,
      "endpoint",
      "private",
      tail(service),
    );
  }

  for (const peering of get("AWS::EC2::VPCPeeringConnection")) {
    const pcxId = str(peering.properties, "Id") ?? peering.identifier;
    const vpcId = str(peering.properties, "VpcId");
    const peerVpcId = str(peering.properties, "PeerVpcId");
    addNode({
      id: `pcx:${pcxId}`,
      kind: "VPC peering",
      label: tagName(peering.properties, pcxId),
      sub: peerVpcId ?? pcxId,
      category: "peering",
      group: placement(undefined, vpcId),
      vpc: vpcId,
      detail: [
        ["Type", "VPC peering"],
        ["Connection", pcxId],
        ["Requester VPC", vpcId ?? "—"],
        ["Peer VPC", peerVpcId ?? "—"],
        ["Peer region", str(peering.properties, "PeerRegion") ?? region],
      ],
    }, peering.properties);
  }

  for (const tgw of get("AWS::EC2::TransitGateway")) {
    const tgwId = tgw.identifier;
    addNode({
      id: `tgw:${tgwId}`,
      kind: "Transit gateway",
      label: tagName(tgw.properties, tgwId),
      sub: tgwId,
      category: "peering",
      group: UNPLACED_GROUP,
      detail: [["Type", "Transit gateway"], ["Gateway", tgwId]],
    }, tgw.properties);
  }

  const hasVpn = get("AWS::EC2::VPNConnection").length > 0;
  if (hasVpn) {
    addNode({
      id: ONPREM_ID,
      kind: "External",
      label: "ON-PREMISES",
      sub: "via VPN",
      category: "external",
      group: EXTERNAL_GROUP,
      alwaysVisible: true,
      detail: [["Scope", "Customer network"]],
    });
    for (const vpn of get("AWS::EC2::VPNConnection")) {
      const vpnId = vpn.identifier;
      addNode({
        id: `vpn:${vpnId}`,
        kind: "VPN connection",
        label: tagName(vpn.properties, vpnId),
        sub: vpnId,
        category: "peering",
        group: UNPLACED_GROUP,
        detail: [
          ["Type", "VPN connection"],
          ["Connection", vpnId],
          ["Customer gateway", str(vpn.properties, "CustomerGatewayId") ?? "—"],
        ],
      }, vpn.properties);
      addLink(`vpn:${vpnId}`, ONPREM_ID, "transit", "private", "ipsec");
    }
  }

  // ---- edge: load balancers, listeners, target groups -------------------

  const lbById = new Map<string, { nodeId: string; vpc?: string }>();
  for (const lb of get("AWS::ElasticLoadBalancingV2::LoadBalancer")) {
    const arn = str(lb.properties, "LoadBalancerArn") ?? lb.identifier;
    const name = str(lb.properties, "Name") ?? tail(arn);
    const scheme = str(lb.properties, "Scheme") ?? "internal";
    const subnets = strings(lb.properties, "Subnets");
    // The ELBv2 CloudControl schema carries no VpcId — a load balancer only
    // knows its subnets. Resolve the VPC through one of them, otherwise every
    // internet-facing balancer loses its inbound path from the gateway.
    const vpcId = str(lb.properties, "VpcId") ??
      subnets.map((subnetId) => subnetVpc.get(subnetId)).find(Boolean);
    const nodeId = `elb:${arn}`;
    lbById.set(arn, { nodeId, vpc: vpcId });
    addNode({
      id: nodeId,
      kind: lbKind(str(lb.properties, "Type")),
      label: name,
      sub: `${str(lb.properties, "Type") ?? "application"} · ${scheme}`,
      category: "balancer",
      group: placement(subnets[0], vpcId),
      vpc: vpcId,
      detail: [
        [
          "Type",
          `${str(lb.properties, "Type") ?? "application"} load balancer`,
        ],
        ["Scheme", scheme],
        ["DNS", str(lb.properties, "DNSName") ?? "—"],
        ["VPC", vpcId ?? "—"],
        ["Subnets", subnets.join(", ") || "—"],
      ],
    }, lb.properties);

    // Internet-facing balancers are the estate's front door: draw the path in
    // from the VPC's internet gateway rather than from the internet directly,
    // so the diagram shows how traffic actually arrives.
    if (scheme === "internet-facing" && vpcId) {
      let attached = false;
      for (const [igwId, attachedVpc] of igwVpc) {
        if (attachedVpc !== vpcId) continue;
        addLink(`igw:${igwId}`, nodeId, "ingress", "public", "inbound");
        attached = true;
      }
      if (!attached) {
        addLink(INTERNET_ID, nodeId, "ingress", "public", "inbound");
      }
    }
  }

  const targetGroupNode = new Map<string, string>();
  for (const tg of get("AWS::ElasticLoadBalancingV2::TargetGroup")) {
    const arn = str(tg.properties, "TargetGroupArn") ?? tg.identifier;
    const name = str(tg.properties, "Name") ?? tail(arn);
    const vpcId = str(tg.properties, "VpcId");
    const nodeId = `tg:${arn}`;
    targetGroupNode.set(arn, nodeId);
    const port = str(tg.properties, "Port") ?? "";
    addNode({
      id: nodeId,
      kind: "Target group",
      label: name,
      sub: port ? `:${port}` : (str(tg.properties, "TargetType") ?? "target"),
      category: "targetgroup",
      group: placement(undefined, vpcId),
      vpc: vpcId,
      detail: [
        ["Type", "Target group"],
        ["Protocol", str(tg.properties, "Protocol") ?? "—"],
        ["Port", port || "—"],
        ["Target type", str(tg.properties, "TargetType") ?? "—"],
      ],
    }, tg.properties);

    // Bind the group to whatever it actually points at. Deferred because
    // instances, Lambdas and nested balancers are added further down, and
    // addLink drops any edge whose endpoints don't exist yet.
    for (const target of arr(tg.properties, "Targets")) {
      if (!target || typeof target !== "object") continue;
      const entry = target as Props;
      const targetId = str(entry, "Id");
      if (!targetId) continue;
      const targetPort = str(entry, "Port") ?? port;
      deferred.push(() => {
        if (targetId.startsWith("i-")) {
          addLink(nodeId, `ec2:${targetId}`, "forward", "private", targetPort);
        } else if (targetId.startsWith("arn:aws:lambda")) {
          addLink(
            nodeId,
            `lambda:${tail(targetId)}`,
            "forward",
            "private",
            "invoke",
          );
        } else if (targetId.startsWith("arn:aws:elasticloadbalancing")) {
          // An ALB sitting behind an NLB — a real hop worth drawing.
          addLink(nodeId, `elb:${targetId}`, "forward", "private", targetPort);
        } else {
          // An IP target: ECS awsvpc tasks and the like. Resolve it when it
          // belongs to an instance; ECS services reach their target groups
          // through their own LoadBalancers block instead.
          const owner = privateIpOwner.get(targetId);
          if (owner) {
            addLink(nodeId, owner, "forward", "private", targetPort);
          }
        }
      });
    }
  }

  for (const listener of get("AWS::ElasticLoadBalancingV2::Listener")) {
    const lbArn = str(listener.properties, "LoadBalancerArn");
    const port = str(listener.properties, "Port") ?? "";
    const protocol = str(listener.properties, "Protocol") ?? "";
    const lb = lbArn ? lbById.get(lbArn) : undefined;
    if (!lb) continue;
    for (const action of arr(listener.properties, "DefaultActions")) {
      if (!action || typeof action !== "object") continue;
      const tgArn = str(action as Props, "TargetGroupArn");
      if (!tgArn) continue;
      const tgNode = targetGroupNode.get(tgArn);
      if (!tgNode) continue;
      addLink(
        lb.nodeId,
        tgNode,
        "forward",
        "private",
        `${protocol}:${port}`.replace(/^:/, ""),
      );
    }
  }

  // ---- compute ----------------------------------------------------------

  const instanceSubnet = new Map<string, string>();
  for (const instance of get("AWS::EC2::Instance")) {
    const instanceId = str(instance.properties, "InstanceId") ??
      instance.identifier;
    const subnetId = str(instance.properties, "SubnetId");
    const vpcId = str(instance.properties, "VpcId") ??
      (subnetId ? subnetVpc.get(subnetId) : undefined);
    if (subnetId) instanceSubnet.set(instanceId, subnetId);
    for (const key of ["PrivateIp", "PrivateIpAddress"]) {
      const ip = str(instance.properties, key);
      if (ip) privateIpOwner.set(ip, `ec2:${instanceId}`);
    }
    const state = obj(instance.properties, "State");
    addNode({
      id: `ec2:${instanceId}`,
      kind: "EC2 instance",
      label: tagName(instance.properties, instanceId),
      sub: str(instance.properties, "PrivateIp") ??
        str(instance.properties, "PrivateIpAddress") ?? instanceId,
      category: "instance",
      group: placement(subnetId, vpcId),
      vpc: vpcId,
      detail: [
        ["Type", "EC2 instance"],
        ["Instance", instanceId],
        ["Size", str(instance.properties, "InstanceType") ?? "—"],
        ["State", state ? str(state, "Name") ?? "—" : "—"],
        ["AZ", str(instance.properties, "AvailabilityZone") ?? "—"],
        ["Private IP", str(instance.properties, "PrivateIp") ?? "—"],
        ["Subnet", subnetId ?? "—"],
      ],
    }, instance.properties);
  }

  for (const asg of get("AWS::AutoScaling::AutoScalingGroup")) {
    const asgName = str(asg.properties, "AutoScalingGroupName") ??
      asg.identifier;
    const zoneIdentifier = str(asg.properties, "VPCZoneIdentifier") ?? "";
    const subnetIds = zoneIdentifier.split(",").map((s) => s.trim()).filter(
      Boolean,
    );
    const vpcId = subnetIds.length ? subnetVpc.get(subnetIds[0]) : undefined;
    const nodeId = `asg:${asgName}`;
    addNode({
      id: nodeId,
      kind: "Auto scaling group",
      label: asgName,
      sub: `${str(asg.properties, "DesiredCapacity") ?? "?"} desired`,
      category: "asg",
      group: placement(subnetIds[0], vpcId),
      vpc: vpcId,
      detail: [
        ["Type", "Auto scaling group"],
        ["Name", asgName],
        [
          "Min / desired / max",
          [
            str(asg.properties, "MinSize") ?? "?",
            str(asg.properties, "DesiredCapacity") ?? "?",
            str(asg.properties, "MaxSize") ?? "?",
          ].join(" / "),
        ],
        ["Subnets", subnetIds.join(", ") || "—"],
      ],
    }, asg.properties);
    for (const tgArn of strings(asg.properties, "TargetGroupARNs")) {
      const tgNode = targetGroupNode.get(tgArn);
      if (tgNode) addLink(tgNode, nodeId, "forward", "private", "scales");
    }
  }

  // ---- managed workloads -------------------------------------------------

  const ecsClusterNode = new Map<string, string>();
  for (const cluster of get("AWS::ECS::Cluster")) {
    const name = str(cluster.properties, "ClusterName") ?? cluster.identifier;
    const nodeId = `ecs:${name}`;
    ecsClusterNode.set(name, nodeId);
    addNode({
      id: nodeId,
      kind: "ECS cluster",
      label: name,
      sub: "ecs cluster",
      category: "ecs",
      group: UNPLACED_GROUP,
      detail: [["Type", "ECS cluster"], ["Name", name]],
    }, cluster.properties);
  }

  for (const service of get("AWS::ECS::Service")) {
    const name = str(service.properties, "ServiceName") ??
      tail(service.identifier);
    const clusterRef = str(service.properties, "Cluster") ?? "";
    const network = obj(service.properties, "NetworkConfiguration");
    const awsvpc = network ? obj(network, "AwsvpcConfiguration") : undefined;
    const subnetIds = awsvpc ? strings(awsvpc, "Subnets") : [];
    const vpcId = subnetIds.length ? subnetVpc.get(subnetIds[0]) : undefined;
    const nodeId = `ecssvc:${service.identifier}`;
    addNode({
      id: nodeId,
      kind: "ECS service",
      label: name,
      sub: `${str(service.properties, "DesiredCount") ?? "?"} tasks`,
      category: "ecs",
      group: placement(subnetIds[0], vpcId),
      vpc: vpcId,
      detail: [
        ["Type", "ECS service"],
        ["Service", name],
        ["Cluster", tail(clusterRef) || "—"],
        ["Launch type", str(service.properties, "LaunchType") ?? "—"],
        [
          "Task definition",
          tail(str(service.properties, "TaskDefinition") ?? ""),
        ],
        ["Subnets", subnetIds.join(", ") || "—"],
      ],
    }, service.properties);

    const clusterNode = ecsClusterNode.get(tail(clusterRef));
    if (clusterNode) addLink(clusterNode, nodeId, "member", "private", "runs");

    for (const balancer of arr(service.properties, "LoadBalancers")) {
      if (!balancer || typeof balancer !== "object") continue;
      const tgArn = str(balancer as Props, "TargetGroupArn");
      const containerPort = str(balancer as Props, "ContainerPort") ?? "";
      if (!tgArn) continue;
      const tgNode = targetGroupNode.get(tgArn);
      if (tgNode) addLink(tgNode, nodeId, "forward", "private", containerPort);
    }
  }

  for (const cluster of get("AWS::EKS::Cluster")) {
    const name = str(cluster.properties, "Name") ?? cluster.identifier;
    const vpcConfig = obj(cluster.properties, "ResourcesVpcConfig");
    const subnetIds = vpcConfig ? strings(vpcConfig, "SubnetIds") : [];
    const vpcId = subnetIds.length ? subnetVpc.get(subnetIds[0]) : undefined;
    addNode({
      id: `eks:${name}`,
      kind: "EKS cluster",
      label: name,
      sub: `eks ${str(cluster.properties, "Version") ?? ""}`.trim(),
      category: "eks",
      group: placement(subnetIds[0], vpcId),
      vpc: vpcId,
      detail: [
        ["Type", "EKS cluster"],
        ["Name", name],
        ["Version", str(cluster.properties, "Version") ?? "—"],
        ["Endpoint", str(cluster.properties, "Endpoint") ?? "—"],
        ["Subnets", subnetIds.join(", ") || "—"],
      ],
    }, cluster.properties);
  }

  for (const nodegroup of get("AWS::EKS::Nodegroup")) {
    const clusterName = str(nodegroup.properties, "ClusterName") ?? "";
    const name = str(nodegroup.properties, "NodegroupName") ??
      tail(nodegroup.identifier);
    const subnetIds = strings(nodegroup.properties, "Subnets");
    const vpcId = subnetIds.length ? subnetVpc.get(subnetIds[0]) : undefined;
    const nodeId = `eksng:${nodegroup.identifier}`;
    addNode({
      id: nodeId,
      kind: "EKS node group",
      label: name,
      sub: "node group",
      category: "eks",
      group: placement(subnetIds[0], vpcId),
      vpc: vpcId,
      detail: [
        ["Type", "EKS node group"],
        ["Name", name],
        ["Cluster", clusterName],
        ["Subnets", subnetIds.join(", ") || "—"],
      ],
    }, nodegroup.properties);
    if (clusterName) {
      addLink(`eks:${clusterName}`, nodeId, "member", "private", "nodes");
    }
  }

  for (const fn of get("AWS::Lambda::Function")) {
    const name = str(fn.properties, "FunctionName") ?? fn.identifier;
    const vpcConfig = obj(fn.properties, "VpcConfig");
    const subnetIds = vpcConfig ? strings(vpcConfig, "SubnetIds") : [];
    const vpcId = subnetIds.length ? subnetVpc.get(subnetIds[0]) : undefined;
    addNode({
      id: `lambda:${name}`,
      kind: "Lambda function",
      label: name,
      sub: str(fn.properties, "Runtime") ?? "lambda",
      category: "lambda",
      group: placement(subnetIds[0], vpcId),
      vpc: vpcId,
      detail: [
        ["Type", "Lambda function"],
        ["Name", name],
        ["Runtime", str(fn.properties, "Runtime") ?? "—"],
        ["Memory", str(fn.properties, "MemorySize") ?? "—"],
        ["VPC", vpcId ?? "none — public egress"],
        ["Subnets", subnetIds.join(", ") || "—"],
      ],
    }, fn.properties);
  }

  // Every node now exists, so the load balancer target edges can be resolved.
  for (const link of deferred) link();

  // ---- routed egress -----------------------------------------------------

  // Walk each subnet's effective route table and draw where its traffic can
  // leave: NAT, internet gateway, peering or an endpoint. This is the outbound
  // half of the picture, and it's read from real routes rather than inferred.
  const groupMembers = new Map<string, string[]>();
  for (const node of nodes) {
    const bucket = groupMembers.get(node.group);
    if (bucket) bucket.push(node.id);
    else groupMembers.set(node.group, [node.id]);
  }

  const EGRESSABLE = new Set([
    "instance",
    "ecs",
    "eks",
    "lambda",
    "asg",
    "balancer",
  ]);

  for (const [subnetId, vpcId] of subnetVpc) {
    const groupId = subnetGroup.get(subnetId);
    if (!groupId) continue;
    const members = (groupMembers.get(groupId) ?? []).filter((id) => {
      const node = nodes.find((candidate) => candidate.id === id);
      return node ? EGRESSABLE.has(node.category) : false;
    });
    if (members.length === 0) continue;

    const tableId = tableForSubnet(subnetId, vpcId);
    if (!tableId) continue;

    for (const route of routesByTable.get(tableId) ?? []) {
      const destination = str(route, "DestinationCidrBlock") ??
        str(route, "DestinationPrefixListId") ?? "";
      const natId = str(route, "NatGatewayId");
      const gatewayId = str(route, "GatewayId");
      const pcxId = str(route, "VpcPeeringConnectionId");
      const vpceId = str(route, "VpcEndpointId");

      for (const member of members) {
        if (natId) {
          addLink(member, `nat:${natId}`, "egress-nat", "public", destination);
        } else if (gatewayId && gatewayId.startsWith("igw-")) {
          addLink(
            member,
            `igw:${gatewayId}`,
            "egress-igw",
            "public",
            destination,
          );
        } else if (pcxId) {
          addLink(member, `pcx:${pcxId}`, "peering", "private", destination);
        } else if (vpceId) {
          addLink(member, `vpce:${vpceId}`, "endpoint", "private", destination);
        }
      }
    }
  }

  // ---- metadata ----------------------------------------------------------

  const seenDomains = new Set(present.map((inventory) => inventory.domain));
  const missingDomains: string[] = [];
  for (const expected of ["network", "compute", "workloads", "edge"]) {
    if (!seenDomains.has(expected)) {
      missingDomains.push(expected);
      warnings.push(`No ${expected} inventory was available for this run.`);
    }
  }
  for (const inventory of present) {
    // A capped listing is worse than a failed one — it looks complete. Say it
    // on the diagram itself rather than leaving a silent hole in the topology.
    for (const typeName of inventory.truncatedTypes ?? []) {
      const note =
        `${typeName} hit the pagination ceiling — some resources are missing from this diagram.`;
      if (!warnings.includes(note)) warnings.push(note);
    }
    for (const error of inventory.errors ?? []) {
      // Per-resource hydration failures are keyed `Type/identifier` and are too
      // granular to surface; only whole types that couldn't be listed matter.
      if (!error.type.includes("/")) {
        const note = `${error.type} could not be listed: ${error.message}`;
        if (!warnings.includes(note)) warnings.push(note);
      }
    }
  }

  // Discovery data outlives any single run, so a domain whose `discover` failed
  // this week silently contributes last week's resources. Age each inventory
  // against now and call out anything past the window — a diagram that quietly
  // presents stale topology as current is worse than one that admits the gap.
  const now = Date.now();
  const domains = present.map((inventory) => {
    const discoveredAt = inventory.discoveredAt ?? "";
    const parsed = discoveredAt ? Date.parse(discoveredAt) : Number.NaN;
    const ageMinutes = Number.isNaN(parsed)
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.round((now - parsed) / 60000));
    return {
      domain: inventory.domain ?? "unknown",
      discoveredAt,
      resourceCount: (inventory.resources ?? []).length,
      ageMinutes: Number.isFinite(ageMinutes) ? ageMinutes : -1,
      stale: !(ageMinutes <= maxAgeMinutes),
    };
  });

  // A domain that has never produced an inventory is absent from `present`
  // entirely, so ageing alone would miss it and leave the freshness assert
  // green. Absent is at least as bad as stale — count it.
  const staleDomains = [
    ...domains.filter((d) => d.stale).map((d) => d.domain),
    ...missingDomains,
  ];
  for (const domain of domains) {
    if (!domain.stale) continue;
    const age = domain.ageMinutes < 0
      ? "an unknown age"
      : `${Math.round(domain.ageMinutes / 60)}h old`;
    warnings.push(
      `The ${domain.domain} inventory is ${age} — its discover step did not refresh in this run.`,
    );
  }

  return {
    meta: {
      region,
      generatedAt: new Date().toISOString(),
      accountHint: `${get("AWS::EC2::VPC").length} VPCs · ${
        get("AWS::EC2::Subnet").length
      } subnets`,
      domains,
      staleDomains,
      warnings,
    },
    groups,
    nodes,
    links,
    categories: CATEGORIES,
    pathTypes: PATH_TYPES,
    tagFacets: buildTagFacets(nodes),
  };
}
