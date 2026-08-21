/**
 * Renders the discovered AWS inventories into a standalone, animated D3
 * architecture diagram.
 *
 * This is a new model type rather than a report because the deliverable is an
 * artifact to hand to someone — reports produce markdown and JSON, whereas a
 * model can emit a file. The four `discover` methods gather; this renders.
 *
 * @module
 */

import { z } from "npm:zod@4";
import { renderDiagram } from "./_lib/diagram_template.ts";
import { buildGraph, type RawInventory } from "./_lib/topology_graph.ts";

const DEFAULT_D3_URL = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js";

/**
 * An inventory arrives from a discovery model as an opaque JSON object.
 *
 * Nullable as well as optional: a `data.latest(...).?attributes` expression for
 * a domain that hasn't run yet resolves to null, and that should degrade the
 * diagram rather than fail the run.
 */
const InventoryArgument = z.record(z.string(), z.unknown()).nullish();

const GlobalArgsSchema = z.object({
  region: z.string().optional().describe(
    "AWS region the diagram describes. Defaults to eu-west-2.",
  ),
  title: z.string().optional().describe(
    "Optional override for the diagram heading.",
  ),
  network: InventoryArgument.describe(
    'Network inventory, wired with data.latest("<model>", "inventory").attributes',
  ),
  compute: InventoryArgument.describe(
    "Compute inventory from the EC2 instance discovery model.",
  ),
  workloads: InventoryArgument.describe(
    "Workload inventory from the ECS cluster discovery model.",
  ),
  edge: InventoryArgument.describe(
    "Edge inventory from the load balancer discovery model.",
  ),
  inlineD3: z.boolean().optional().describe(
    "Embed the D3 library in the HTML so the file works offline. Defaults to true.",
  ),
  d3Url: z.string().optional().describe(
    `Source for the D3 library. Defaults to ${DEFAULT_D3_URL}`,
  ),
  publishDir: z.string().optional().describe(
    "Directory, relative to the repo root, to publish the diagram into. Defaults to diagrams.",
  ),
  maxInventoryAgeMinutes: z.number().optional().describe(
    "How old an inventory may be before it counts as stale. Defaults to 360 (6 hours).",
  ),
});

const SummarySchema = z.object({
  region: z.string(),
  generatedAt: z.string(),
  nodeCount: z.number(),
  linkCount: z.number(),
  vpcCount: z.number(),
  subnetCount: z.number(),
  publicPathCount: z.number(),
  privatePathCount: z.number(),
  categories: z.record(z.string(), z.number()),
  pathTypes: z.record(z.string(), z.number()),
  tagKeys: z.record(z.string(), z.number()),
  untaggedNodeCount: z.number(),
  publishedPath: z.string(),
  d3Embedded: z.boolean(),
  freshDomainCount: z.number(),
  staleDomains: z.array(z.string()),
  warnings: z.array(z.string()),
});

/** Coerce a global argument into an inventory, tolerating absence. */
function asInventory(value: unknown): RawInventory | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as RawInventory;
  return Array.isArray(candidate.resources) ? candidate : undefined;
}

/**
 * Fetch the D3 library so it can be inlined.
 *
 * Returns undefined on any failure — the diagram then falls back to a CDN script
 * tag, which still works for anyone online. A weekly job shouldn't fail because
 * a CDN blipped.
 */
async function fetchD3(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    const source = await response.text();
    return source.length > 1000 ? source : undefined;
  } catch {
    return undefined;
  }
}

interface RenderContext {
  globalArgs: Record<string, unknown>;
  repoDir: string;
  logger?: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  createFileWriter: (
    specName: string,
    instanceName: string,
  ) => { writeText: (text: string) => Promise<unknown> };
}

/** Model that turns AWS discovery output into a shareable diagram. */
export const model = {
  type: "@aaronge/aws-architecture-diagram",
  version: "2026.08.21.1",
  // The tag filter changed what the renderer emits, not what it is configured
  // with: `summary` gained tag coverage fields, while the global arguments are
  // untouched. Existing instances still need the entry to move their
  // typeVersion forward, so it carries the attributes across unchanged.
  upgrades: [
    {
      toVersion: "2026.08.21.1",
      description:
        "Tag filtering and relabelled tiles; no global argument changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    "summary": {
      description: "Counts and metadata describing the rendered diagram",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 12,
    },
  },
  files: {
    "html": {
      description: "Standalone animated D3 architecture diagram",
      contentType: "text/html",
      lifetime: "infinite" as const,
      garbageCollection: 12,
    },
  },
  methods: {
    render: {
      description:
        "Render the discovered inventories into an animated D3 architecture diagram",
      arguments: z.object({
        region: z.string().optional().describe(
          "Override the region label and output filename.",
        ),
      }),
      execute: async (
        args: { region?: string },
        context: RenderContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = context.globalArgs;
        const region = args.region ??
          (typeof g.region === "string" && g.region ? g.region : "eu-west-2");

        const inventories = [
          asInventory(g.network),
          asInventory(g.compute),
          asInventory(g.workloads),
          asInventory(g.edge),
        ].filter((inventory): inventory is RawInventory => Boolean(inventory));

        if (inventories.length === 0) {
          throw new Error(
            "No inventories were supplied. Wire at least one discovery model in, " +
              'e.g. network: ${{ data.latest("aws-network", "inventory").attributes }}',
          );
        }

        context.logger?.info(
          "Building topology from {count} inventories for {region}",
          { count: inventories.length, region },
        );

        const maxAge = typeof g.maxInventoryAgeMinutes === "number"
          ? g.maxInventoryAgeMinutes
          : 360;
        const graph = buildGraph(inventories, region, maxAge);

        // Inventories persist between runs, so a render can succeed on nothing
        // but last week's data. Refuse that outright — a diagram nobody can
        // trust the date of is worse than no diagram.
        const freshDomainCount = graph.meta.domains.filter((d) => !d.stale)
          .length;
        if (freshDomainCount === 0) {
          throw new Error(
            `Every inventory is older than ${maxAge} minutes (${
              graph.meta.staleDomains.join(", ")
            }). Discovery did not refresh anything this run — refusing to publish a stale diagram.`,
          );
        }

        const wantInline = g.inlineD3 !== false;
        const d3Url = typeof g.d3Url === "string" && g.d3Url
          ? g.d3Url
          : DEFAULT_D3_URL;
        const inline = wantInline ? await fetchD3(d3Url) : undefined;
        if (wantInline && !inline) {
          context.logger?.info(
            "Could not inline D3 from {url}; falling back to a CDN script tag",
            { url: d3Url },
          );
        }

        const html = renderDiagram(graph, { inline, url: d3Url });

        const writer = context.createFileWriter("html", `diagram-${region}`);
        const handle = await writer.writeText(html);

        // Also drop a copy at a stable path so the weekly artifact can simply be
        // sent on to someone without going through the datastore.
        const publishDir = typeof g.publishDir === "string" && g.publishDir
          ? g.publishDir
          : "diagrams";
        const targetDir = `${context.repoDir}/${publishDir}`;
        const publishedPath = `${publishDir}/aws-architecture-${region}.html`;
        try {
          await Deno.mkdir(targetDir, { recursive: true });
          await Deno.writeTextFile(
            `${context.repoDir}/${publishedPath}`,
            html,
          );
        } catch (error) {
          context.logger?.info("Could not publish a repo copy: {error}", {
            error: error instanceof Error ? error.message : String(error),
          });
        }

        const categories: Record<string, number> = {};
        for (const node of graph.nodes) {
          categories[node.category] = (categories[node.category] ?? 0) + 1;
        }
        const pathTypes: Record<string, number> = {};
        for (const link of graph.links) {
          pathTypes[link.pathType] = (pathTypes[link.pathType] ?? 0) + 1;
        }

        // Tag coverage travels with the summary so an untagged estate is
        // visible from `swamp data get` — the diagram's tag filter is only as
        // good as the tagging behind it.
        const tagKeys: Record<string, number> = {};
        for (const facet of graph.tagFacets) {
          tagKeys[facet.key] = facet.taggedCount;
        }
        const untaggedNodeCount =
          graph.nodes.filter((node) =>
            !node.alwaysVisible && Object.keys(node.tags).length === 0
          ).length;

        const summaryHandle = await context.writeResource(
          "summary",
          "summary",
          {
            region,
            generatedAt: graph.meta.generatedAt,
            nodeCount: graph.nodes.length,
            linkCount: graph.links.length,
            vpcCount:
              graph.groups.filter((group) => group.kind === "vpc").length,
            subnetCount:
              graph.groups.filter((group) => group.kind === "subnet").length,
            publicPathCount:
              graph.links.filter((link) => link.scope === "public").length,
            privatePathCount:
              graph.links.filter((link) => link.scope === "private").length,
            categories,
            pathTypes,
            tagKeys,
            untaggedNodeCount,
            publishedPath,
            d3Embedded: Boolean(inline),
            freshDomainCount,
            staleDomains: graph.meta.staleDomains,
            warnings: graph.meta.warnings,
          },
        );

        context.logger?.info(
          "Rendered {nodes} objects and {links} paths to {path}",
          {
            nodes: graph.nodes.length,
            links: graph.links.length,
            path: publishedPath,
          },
        );

        return { dataHandles: [handle, summaryHandle] };
      },
    },
  },
};
