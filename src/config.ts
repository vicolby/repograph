import { z } from "zod";

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
