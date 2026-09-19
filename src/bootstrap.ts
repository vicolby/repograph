import neo4j, { type Driver } from "neo4j-driver";
import { z } from "zod";

// Single startup-wiring module for the MCP entrypoint: env config plus the
// shared Neo4j driver live here together (previously split across
// `src/config.ts` and `src/neo4j/driver.ts`, each a pass-through with a
// single consumer — a hypothetical seam per the two-adapters rule). Only
// `src/index.ts` (production) and the test fixture import from here.

const envSchema = z.object({
  NEO4J_URI: z.string().min(1).default("bolt://localhost:7687"),
  NEO4J_USER: z.string().min(1).default("neo4j"),
  NEO4J_PASSWORD: z.string().min(1, "NEO4J_PASSWORD must be set"),
  NEO4J_DATABASE: z.string().min(1).default("neo4j"),
});

export type Neo4jConfig = {
  uri: string;
  user: string;
  password: string;
  database: string;
};

/**
 * Reads Neo4j connection settings from environment variables.
 * Throws a descriptive error if required variables are missing.
 */
export function loadNeo4jConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): Neo4jConfig {
  const parsed = envSchema.parse(env);
  return {
    uri: parsed.NEO4J_URI,
    user: parsed.NEO4J_USER,
    password: parsed.NEO4J_PASSWORD,
    database: parsed.NEO4J_DATABASE,
  };
}

/**
 * Creates the shared Neo4j driver instance used by the MCP server and its
 * tools. Callers own the driver's lifecycle and must close it on shutdown.
 */
export function createNeo4jDriver(config: Neo4jConfig): Driver {
  return neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
}

/** Confirms the driver can reach Neo4j, throwing if it cannot. */
export async function verifyNeo4jConnectivity(driver: Driver, database: string): Promise<void> {
  await driver.verifyConnectivity({ database });
}

export async function closeNeo4jDriver(driver: Driver): Promise<void> {
  await driver.close();
}
