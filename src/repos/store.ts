import type { Driver } from "neo4j-driver";
import { addRelation, type AddRelationInput, type RelationEdge } from "./addRelation.js";
import { addRepo, type AddRepoInput, type RepoNode } from "./addRepo.js";
import { getRelatedRepos, type GetRelatedReposInput } from "./getRelatedRepos.js";
import { searchRepos, type SearchReposInput } from "./searchRepos.js";
import { supersedeRelation, type SupersedeRelationInput } from "./supersedeRelation.js";

// Public seam of the src/repos/ module: outside callers (the MCP server,
// tests, fixtures) import only this file. Everything else in this directory —
// session handling, constraints, mapping (db.ts), validation (input.ts),
// identifier normalization (normalize.ts), per-tool Cypher — is internal.

// Domain types, re-exported so callers never reach past this seam.
export type {
  AddRelationInput,
  AddRepoInput,
  GetRelatedReposInput,
  RelationEdge,
  RepoNode,
  SearchReposInput,
  SupersedeRelationInput,
};

/** Bound handle to the repo graph: driver and database fixed once, not per call. */
export type RepoStore = {
  addRepo(input: AddRepoInput): Promise<RepoNode>;
  addRelation(input: AddRelationInput): Promise<RelationEdge>;
  supersedeRelation(input: SupersedeRelationInput): Promise<RelationEdge>;
  getRelatedRepos(input: GetRelatedReposInput): Promise<RepoNode[]>;
  searchRepos(input: SearchReposInput): Promise<RepoNode[]>;
};

/** Binds a driver and database into the single interface the repos module offers. */
export function createRepoStore(driver: Driver, database: string): RepoStore {
  return {
    addRepo: (input) => addRepo(driver, database, input),
    addRelation: (input) => addRelation(driver, database, input),
    supersedeRelation: (input) => supersedeRelation(driver, database, input),
    getRelatedRepos: (input) => getRelatedRepos(driver, database, input),
    searchRepos: (input) => searchRepos(driver, database, input),
  };
}
