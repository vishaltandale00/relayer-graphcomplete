import {
  GRAPH_QUERY_ERROR_PHASES,
  type GeneratedGraphQueryCode,
  type GeneratedGraphQueryPhase,
} from "./query-errors.generated.js";

export type GraphQueryCode = GeneratedGraphQueryCode;
export type GraphQueryPhase = GeneratedGraphQueryPhase;

export interface GraphQueryBudget {
  readonly queryBytes?: number;
  readonly astDepth?: number;
  readonly variables?: number;
  readonly patternParts?: number;
  readonly traversalHops?: number;
  readonly examinedExpansions?: number;
  readonly intermediateRows?: number;
  readonly wallTimeMs?: number;
  readonly resultRows?: number;
  readonly encodedResultBytes?: number;
}

export type GraphQueryTypeDescriptor =
  | { readonly kind: "null" | "boolean" | "integer" | "float" | "string" | "node" | "layer" | "relationship" | "path" }
  | { readonly kind: "list"; readonly elementType: GraphQueryTypeDescriptor }
  | { readonly kind: "record"; readonly fields: readonly GraphQueryRecordTypeField[] };

export interface GraphQueryRecordTypeField {
  readonly name: string;
  readonly type: GraphQueryTypeDescriptor;
}

export interface GraphQueryNullValue { readonly type: "null" }
export interface GraphQueryBooleanValue { readonly type: "boolean"; readonly value: boolean }
/** Signed 64-bit integers intentionally remain decimal strings across JSON runtimes. */
export interface GraphQueryIntegerValue { readonly type: "integer"; readonly value: string }
export interface GraphQueryFloatValue { readonly type: "float"; readonly value: number }
export interface GraphQueryStringValue { readonly type: "string"; readonly value: string }

export interface GraphQueryProperty {
  readonly name: string;
  readonly value: GraphQueryValue;
}

export interface GraphQueryNodeValue {
  readonly type: "node";
  readonly id: string;
  readonly kind: "Content";
  readonly properties: readonly GraphQueryProperty[];
}

export interface GraphQueryLayerValue {
  readonly type: "layer";
  readonly id: string;
  readonly kind: "Layer";
  readonly properties: readonly GraphQueryProperty[];
}

export interface GraphQueryRelationshipValue {
  readonly type: "relationship";
  readonly id: string;
  readonly kind: "CONNECTED" | "CONTAINS" | "EXPANDS" | "REFERENCES";
  readonly start: string;
  readonly end: string;
  readonly directed: boolean;
  readonly properties: readonly GraphQueryProperty[];
}

export interface GraphQueryPathValue {
  readonly type: "path";
  readonly vertices: readonly (GraphQueryNodeValue | GraphQueryLayerValue)[];
  readonly relationships: readonly GraphQueryRelationshipValue[];
}

export interface GraphQueryListValue {
  readonly type: "list";
  readonly elementType: GraphQueryTypeDescriptor;
  readonly values: readonly GraphQueryValue[];
}

export interface GraphQueryRecordField {
  readonly name: string;
  readonly value: GraphQueryValue;
}

export interface GraphQueryRecordValue {
  readonly type: "record";
  readonly fields: readonly GraphQueryRecordField[];
}

export type GraphQueryValue =
  | GraphQueryNullValue
  | GraphQueryBooleanValue
  | GraphQueryIntegerValue
  | GraphQueryFloatValue
  | GraphQueryStringValue
  | GraphQueryNodeValue
  | GraphQueryLayerValue
  | GraphQueryRelationshipValue
  | GraphQueryPathValue
  | GraphQueryListValue
  | GraphQueryRecordValue;

/**
 * Public current-thread search envelope. It deliberately has no target,
 * project, thread, scope, permit, credential, or other authority selector.
 */
export interface GraphSearchRequest {
  readonly queryContractVersion: 1;
  readonly query: string;
  readonly parameters?: Readonly<Record<string, GraphQueryValue>>;
  readonly budget?: GraphQueryBudget;
}

export interface GraphSearchResult {
  readonly queryContractVersion: 1;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly GraphQueryValue[])[];
  readonly truncated: boolean;
}

export interface GraphSearchOptions {
  readonly signal?: AbortSignal;
}

export interface GraphQueryErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly phase?: string;
    readonly path?: string;
    readonly message?: string;
  };
}

export class GraphQueryError extends Error {
  constructor(
    readonly status: number,
    readonly code: GraphQueryCode,
    readonly phase: GraphQueryPhase,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "GraphQueryError";
  }
}

export function isGraphQueryErrorBody(body: GraphQueryErrorBody): body is {
  readonly error: {
    readonly code: GraphQueryCode;
    readonly phase: GraphQueryPhase;
    readonly path: string;
    readonly message?: string;
  };
} {
  const code = body.error?.code;
  if (typeof code !== "string" || !(code in GRAPH_QUERY_ERROR_PHASES)) return false;
  const queryCode = code as GraphQueryCode;
  return body.error?.phase === GRAPH_QUERY_ERROR_PHASES[queryCode]
    && typeof body.error.path === "string";
}
