// Shared CloudControl discovery helper for the AWS topology extensions.
//
// The official `@swamp/aws/*` model types are auto-generated CloudControl CRUD
// wrappers — every type exposes only create/get/update/delete/sync against a
// single identifier. Building a region-wide architecture diagram needs the one
// operation they don't expose: list. This helper adds it using the exact same
// dependency the official extensions already pin in their own
// `models/_lib/aws.ts`, so no new client surface is introduced.
//
// @module

import {
  CloudControlClient,
  GetResourceCommand,
  ListResourcesCommand,
} from "npm:@aws-sdk/client-cloudcontrol@3.1090.0";

/** AWS credentials resolved from model global arguments. */
export interface AwsCredentials {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  region?: string;
}

/** A single resource returned by a CloudControl list call. */
export interface DiscoveredResource {
  /** CloudFormation type name, e.g. `AWS::EC2::Subnet`. */
  type: string;
  /** CloudControl primary identifier for the resource. */
  identifier: string;
  /** Parsed resource properties. Empty when the payload could not be parsed. */
  properties: Record<string, unknown>;
}

/** A type that could not be listed, recorded rather than thrown. */
export interface DiscoveryError {
  type: string;
  message: string;
}

/** Aggregate result of discovering one domain in one region. */
export interface DiscoveryResult {
  resources: DiscoveredResource[];
  errors: DiscoveryError[];
  counts: Record<string, number>;
}

/**
 * A type to list, optionally scoped by a parent resource.
 *
 * CloudControl refuses to list some child types without their parent — listing
 * `AWS::ECS::Service` requires a cluster, `AWS::EC2::Route` requires a route
 * table. `resourceModel` carries that parent context.
 */
export interface ListTarget {
  typeName: string;
  resourceModel?: Record<string, unknown>;
}

const MAX_PAGES = 200;
const MAX_RETRIES = 10;
const BASE_DELAY_MS = 750;
const MAX_DELAY_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function isThrottlingError(error: unknown): boolean {
  const msg = errorMessage(error);
  const name = errorName(error);
  return (
    name === "ThrottlingException" ||
    name === "TooManyRequestsException" ||
    name === "RequestLimitExceeded" ||
    msg.includes("Throttling") ||
    msg.includes("TooManyRequests") ||
    msg.includes("RequestLimitExceeded") ||
    // CloudControl's own throttle response carries this bare message.
    msg.includes("Rate exceeded") ||
    msg.includes("Too Many Requests")
  );
}

/**
 * True when a type simply isn't listable in this account/region.
 *
 * CloudControl surfaces "this type has no list handler", "you lack permission"
 * and "this service isn't enabled here" as hard errors. For a read-only
 * inventory these are expected gaps, not failures — the diagram should still
 * render from whatever else was found.
 */
export function isTolerableListError(error: unknown): boolean {
  const msg = errorMessage(error);
  const name = errorName(error);
  return (
    name === "UnsupportedActionException" ||
    name === "TypeNotFoundException" ||
    name === "AccessDeniedException" ||
    name === "InvalidRequestException" ||
    name === "ResourceNotFoundException" ||
    name === "GeneralServiceException" ||
    msg.includes("not supported") ||
    msg.includes("does not support") ||
    msg.includes("AccessDenied") ||
    msg.includes("is not authorized") ||
    msg.includes("UnauthorizedOperation") ||
    msg.includes("not found") ||
    msg.includes("OptInRequired")
  );
}

/** Resolve the region from global args, then env, defaulting to eu-west-2. */
export function resolveRegion(
  explicitRegion: string | undefined,
  globalArgs: Record<string, unknown>,
): string {
  if (explicitRegion) return explicitRegion;
  const fromArgs = globalArgs.region;
  if (typeof fromArgs === "string" && fromArgs) return fromArgs;
  return Deno.env.get("AWS_REGION") ?? Deno.env.get("AWS_DEFAULT_REGION") ??
    "eu-west-2";
}

/**
 * Build credentials from model global arguments.
 *
 * Mirrors the official extensions: explicit args win, otherwise fall through to
 * the standard AWS credential chain (env vars, profile, instance role).
 */
export function buildCredentials(
  globalArgs: Record<string, unknown>,
): AwsCredentials {
  const pick = (key: string): string | undefined => {
    const value = globalArgs[key];
    return typeof value === "string" && value ? value : undefined;
  };
  return {
    accessKeyId: pick("accessKeyId"),
    secretAccessKey: pick("secretAccessKey"),
    sessionToken: pick("sessionToken"),
  };
}

/** Create a CloudControl client for a region. */
export function createClient(
  region: string,
  credentials: AwsCredentials,
): CloudControlClient {
  const config: Record<string, unknown> = { region };
  if (credentials.accessKeyId && credentials.secretAccessKey) {
    config.credentials = {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken
        ? { sessionToken: credentials.sessionToken }
        : {}),
    };
  }
  return new CloudControlClient(config);
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isThrottlingError(error) || attempt === MAX_RETRIES - 1) throw error;
      const backoff = Math.min(
        BASE_DELAY_MS * Math.pow(2, attempt),
        MAX_DELAY_MS,
      );
      await delay(backoff + Math.random() * 0.3 * backoff);
    }
  }
  throw lastError;
}

/**
 * List every resource of one CloudControl type, following pagination.
 *
 * Throws only on genuinely unexpected errors; callers use
 * {@link isTolerableListError} to decide what to record and skip.
 */
export async function listResources(
  client: CloudControlClient,
  target: ListTarget,
): Promise<DiscoveredResource[]> {
  const found: DiscoveredResource[] = [];
  let nextToken: string | undefined = undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await withRetry(() =>
      client.send(
        new ListResourcesCommand({
          TypeName: target.typeName,
          ...(target.resourceModel
            ? { ResourceModel: JSON.stringify(target.resourceModel) }
            : {}),
          ...(nextToken ? { NextToken: nextToken } : {}),
        }),
      )
    );

    for (const description of response.ResourceDescriptions ?? []) {
      let properties: Record<string, unknown> = {};
      if (description.Properties) {
        try {
          const parsed = JSON.parse(description.Properties);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            properties = parsed as Record<string, unknown>;
          }
        } catch {
          // Malformed payload — keep the identifier, drop the properties.
        }
      }
      found.push({
        type: target.typeName,
        identifier: description.Identifier ?? "",
        properties,
      });
    }

    nextToken = response.NextToken;
    if (!nextToken) break;
  }

  return found;
}

/** Logger surface used by discovery, satisfied by `context.logger`. */
export interface DiscoveryLogger {
  info: (message: string, properties?: Record<string, unknown>) => void;
  warn?: (message: string, properties?: Record<string, unknown>) => void;
  warning?: (message: string, properties?: Record<string, unknown>) => void;
}

/**
 * Discover many CloudControl types in one region, tolerating per-type gaps.
 *
 * This is the fan-out primitive the discovery models are built on: one call
 * lists an entire domain, so a model acquires its lock once instead of being
 * hammered by N separate method runs.
 */
export async function discoverTypes(
  client: CloudControlClient,
  targets: ListTarget[],
  logger?: DiscoveryLogger,
): Promise<DiscoveryResult> {
  const resources: DiscoveredResource[] = [];
  const errors: DiscoveryError[] = [];
  const counts: Record<string, number> = {};

  for (const target of targets) {
    try {
      const found = await listResources(client, target);
      resources.push(...found);
      counts[target.typeName] = (counts[target.typeName] ?? 0) + found.length;
      logger?.info("Discovered {count} of {type}", {
        count: found.length,
        type: target.typeName,
      });
    } catch (error) {
      const message = errorMessage(error);
      if (!isTolerableListError(error)) throw error;
      errors.push({ type: target.typeName, message });
      counts[target.typeName] = counts[target.typeName] ?? 0;
      // Call through the logger object — pulling the method off it first would
      // detach `this` and blow up inside LogTape.
      if (logger?.warning) {
        logger.warning("Skipped {type}: {message}", {
          type: target.typeName,
          message,
        });
      } else if (logger?.warn) {
        logger.warn("Skipped {type}: {message}", {
          type: target.typeName,
          message,
        });
      }
    }
  }

  return { resources, errors, counts };
}

const HYDRATE_CONCURRENCY = 4;

/**
 * Fetch the full property set for one resource.
 *
 * `ListResources` is deliberately thin — for many types it returns nothing but
 * the primary identifier. `GetResource` is the only way to see a VPC's CIDR, a
 * security group's rules or a peering connection's accepter.
 */
export async function getResource(
  client: CloudControlClient,
  typeName: string,
  identifier: string,
): Promise<Record<string, unknown> | undefined> {
  const response = await withRetry(() =>
    client.send(
      new GetResourceCommand({ TypeName: typeName, Identifier: identifier }),
    )
  );
  const payload = response.ResourceDescription?.Properties;
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed payload — leave the listed properties untouched.
  }
  return undefined;
}

/**
 * Fill in full properties for the listed types, in bounded parallel.
 *
 * Mutates the resources in place, merging fetched properties over the sparse
 * ones from listing. Individual failures are tolerated — a resource that can't
 * be read keeps whatever listing gave us rather than sinking the whole run.
 */
export async function hydrateResources(
  client: CloudControlClient,
  resources: DiscoveredResource[],
  typeNames: string[],
  logger?: DiscoveryLogger,
): Promise<DiscoveryError[]> {
  const wanted = new Set(typeNames);
  const queue = resources.filter(
    (resource) => wanted.has(resource.type) && resource.identifier,
  );
  if (queue.length === 0) return [];

  logger?.info("Hydrating {count} resources", { count: queue.length });

  const errors: DiscoveryError[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= queue.length) return;
      const resource = queue[index];
      try {
        const properties = await getResource(
          client,
          resource.type,
          resource.identifier,
        );
        if (properties) {
          resource.properties = { ...resource.properties, ...properties };
        }
      } catch (error) {
        // Hydration is enrichment, never the point of failure: the resource is
        // already known from listing, so a read that throttles out or is denied
        // costs detail on one node rather than the whole weekly diagram.
        errors.push({
          type: `${resource.type}/${resource.identifier}`,
          message: errorMessage(error),
        });
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(HYDRATE_CONCURRENCY, queue.length) },
      () => worker(),
    ),
  );

  return errors;
}

/** Read a string property from a discovered resource, if present. */
export function stringProp(
  resource: DiscoveredResource,
  key: string,
): string | undefined {
  const value = resource.properties[key];
  return typeof value === "string" && value ? value : undefined;
}
