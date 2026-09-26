import { describe, expect, it } from "vitest";
import { isNaturalGraphMemoryQueryShape } from "../src/cases/natural-graph-memory-query.js";

describe("natural graph-memory query shape", () => {
  it.each([
    "MATCH (layer:Layer)-[:CONTAINS]->(content:Content) WHERE content.title = $topic RETURN layer",
    "MATCH path=(content:Content)<-[:CONTAINS]-(layer:Layer) WHERE $topic = content.title RETURN DISTINCT layer AS result ORDER BY layer.id DESC LIMIT 8;",
  ])("accepts bounded forward and reverse CONTAINS queries: %s", (query) => {
    expect(isNaturalGraphMemoryQueryShape(query, "topic")).toBe(true);
  });

  it("escapes the parameter name exactly once", () => {
    const query = "MATCH (layer:Layer)-[:CONTAINS]->(content:Content) WHERE content.title = $topic.name RETURN layer";
    expect(isNaturalGraphMemoryQueryShape(query, "topic.name")).toBe(true);
    expect(isNaturalGraphMemoryQueryShape(query, "topicXname")).toBe(false);
  });

  it.each([
    "MATCH (layer:Layer)-[:CONTAINS]->(content:Content) WHERE content.title = $topic RETURN layer; CREATE (x)",
    "MATCH (layer:Layer)-[:CONTAINS]->(content:Content) WHERE content.title = $topic RETURN layer LIMIT 1; LIMIT 2",
    "MATCH (layer:Layer)-[:CONTAINS]->(content:Content) WHERE content.title = $topic RETURN layer LIMIT 9",
  ])("rejects additional statements or out of range limits: %s", (query) => {
    expect(isNaturalGraphMemoryQueryShape(query, "topic")).toBe(false);
  });

  it("keeps the runtime and recursive case-insensitive flags distinct", () => {
    const query = "MATCH (layer:Layer)-[:CONTAINS]->(content:Content) WHERE content.title = $topic RETURN DIſTINCT layer";
    expect(isNaturalGraphMemoryQueryShape(query, "topic", "i")).toBe(false);
    expect(isNaturalGraphMemoryQueryShape(query, "topic", "iu")).toBe(true);
  });
});
