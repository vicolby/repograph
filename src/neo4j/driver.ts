import neo4j, { type Driver } from "neo4j-driver";
import type { Neo4jConfig } from "../config.js";

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
