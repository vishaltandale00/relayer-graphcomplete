import { randomUUID } from "node:crypto";

export type InputOperatorId = string | number;

export interface InputOccurrenceSnapshot {
  readonly presentingInteractionNodeId: number;
  readonly presentingLayerId: number;
  readonly actionId: number;
}

export interface InputOptionSnapshot {
  readonly key: string;
  readonly label: string;
}

export type InputActionSnapshot =
  | { readonly control: "text"; readonly prompt: string }
  | { readonly control: "single_select"; readonly prompt: string; readonly options: readonly InputOptionSnapshot[] }
  | {
      readonly control: "multi_select";
      readonly prompt: string;
      readonly options: readonly InputOptionSnapshot[];
      readonly minimumSelections?: number;
    };

export type InputOperatorValue =
  | { readonly text: string }
  | { readonly selectedKeys: readonly string[] };

export type ProductInputValue =
  | { readonly text: string }
  | { readonly selected: readonly InputOptionSnapshot[] };

export interface InputOperatorAuthority {
  readonly kind: "scoped_product_write";
  readonly threadId: InputOperatorId;
  /** Audit identity only. The injected transport owns the actual credential. */
  readonly authorityId: string;
}

export interface InputOperatorTransport {
  request(
    path: string,
    request: { readonly method: "GET" | "PUT" | "POST"; readonly body?: Readonly<Record<string, unknown>> },
  ): Promise<unknown>;
}

export interface InputCaptureInput {
  readonly occurrence: InputOccurrenceSnapshot;
  readonly action: InputActionSnapshot;
  readonly threadRevision: string;
}

export interface InputOperatorState {
  readonly activeCaptureId: string | null;
  readonly activeCaptureIds: readonly string[];
  readonly writeInFlight: boolean;
  readonly captures: readonly {
    readonly captureId: string;
    readonly status: "capturing" | "commissioned" | "consumed" | "failed";
    readonly threadRevision: string;
    readonly ratingId: string | null;
    readonly failure: "capture_failed" | "capture_timeout" | null;
  }[];
  readonly committedDraftRevision: number | null;
}

export class InputOperatorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "InputOperatorError";
  }
}

interface CaptureRecord extends InputCaptureInput {
  readonly captureId: string;
  status: "capturing" | "commissioned" | "consumed" | "failed";
  ratingId: string | null;
  failure: "capture_failed" | "capture_timeout" | null;
  timeout: ReturnType<typeof setTimeout> | null;
  released: Promise<void>;
  release: () => void;
}

export interface InputOperatorOptions {
  readonly authority: InputOperatorAuthority;
  readonly transport: InputOperatorTransport;
  readonly captureTimeoutMs?: number;
  readonly createId?: () => string;
}

export class InputOperatorController {
  readonly authority: InputOperatorAuthority;
  readonly #transport: InputOperatorTransport;
  readonly #captureTimeoutMs: number;
  readonly #createId: () => string;
  readonly #captures = new Map<string, CaptureRecord>();
  readonly #activeCaptureIds = new Set<string>();
  #writeInFlight = false;
  #committedDraftRevision: number | null = null;

  constructor(options: InputOperatorOptions) {
    if (options.authority.kind !== "scoped_product_write") {
      throw new InputOperatorError("input_operator_authority_required", "The input operator requires scoped product write authority.");
    }
    if (!String(options.authority.threadId).trim() || !options.authority.authorityId.trim()) {
      throw new InputOperatorError("input_operator_authority_invalid", "The input operator authority is incomplete.");
    }
    if (!options.transport?.request) {
      throw new InputOperatorError("input_operator_transport_required", "The input operator requires an authorized product transport.");
    }
    const captureTimeoutMs = options.captureTimeoutMs ?? 10 * 60_000;
    if (!Number.isSafeInteger(captureTimeoutMs) || captureTimeoutMs < 1) {
      throw new InputOperatorError("input_operator_timeout_invalid", "Capture timeout must be a positive integer.");
    }
    this.authority = Object.freeze({ ...options.authority });
    this.#transport = options.transport;
    this.#captureTimeoutMs = captureTimeoutMs;
    this.#createId = options.createId ?? randomUUID;
  }

  beginCapture(input: InputCaptureInput): { readonly captureId: string; readonly threadRevision: string } {
    if (this.#writeInFlight) {
      throw new InputOperatorError("input_operator_write_active", "A capture cannot begin while an operator write is in flight.");
    }
    validateOccurrence(input.occurrence);
    validateActionSnapshot(input.action);
    if ([...this.#activeCaptureIds].some((captureId) => (
      sameOccurrence(this.#captures.get(captureId)!.occurrence, input.occurrence)
    ))) {
      throw new InputOperatorError("input_operator_capture_active", "This input occurrence already has an active capture-and-rate interval.");
    }
    if (!input.threadRevision.trim()) {
      throw new InputOperatorError("input_operator_revision_required", "Capture requires a stable thread revision.");
    }
    const captureId = this.#createId();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const record: CaptureRecord = {
      captureId,
      occurrence: structuredClone(input.occurrence),
      action: structuredClone(input.action),
      threadRevision: input.threadRevision,
      status: "capturing",
      ratingId: null,
      failure: null,
      timeout: null,
      released,
      release,
    };
    record.timeout = setTimeout(() => this.#failCapture(record, "capture_timeout"), this.#captureTimeoutMs);
    this.#captures.set(captureId, record);
    this.#activeCaptureIds.add(captureId);
    return { captureId, threadRevision: record.threadRevision };
  }

  rateCapture(input: { readonly captureId: string; readonly ratingId: string; readonly threadRevision: string }): void {
    this.rateCaptures([input]);
  }

  rateCaptures(inputs: readonly {
    readonly captureId: string;
    readonly ratingId: string;
    readonly threadRevision: string;
  }[]): void {
    if (inputs.length === 0) return;
    const uniqueIds = new Set(inputs.map(({ captureId }) => captureId));
    if (uniqueIds.size !== inputs.length) {
      throw new InputOperatorError("input_operator_capture_duplicate", "A rating batch cannot commission one capture twice.");
    }
    const records = inputs.map((input) => {
      const record = this.#requireCapture(input.captureId);
      if (record.status !== "capturing") {
        throw new InputOperatorError("input_operator_capture_not_active", "Only an active capture can be rated.");
      }
      if (!input.ratingId.trim()) {
        throw new InputOperatorError("input_operator_rating_required", "A durable rating identity is required before commission.");
      }
      if (input.threadRevision !== record.threadRevision) {
        throw new InputOperatorError("input_operator_revision_mismatch", "The rating must cite the exact revision captured.");
      }
      return { input, record };
    });
    for (const { input, record } of records) {
      record.status = "commissioned";
      record.ratingId = input.ratingId;
      this.#releaseCapture(record);
    }
  }

  failCapture(captureId: string): void {
    const record = this.#requireCapture(captureId);
    if (record.status !== "capturing") return;
    this.#failCapture(record, "capture_failed");
  }

  async commit(input: {
    readonly captureId: string;
    readonly value: InputOperatorValue;
    readonly expectedRevision?: number;
  }): Promise<number> {
    const record = this.#requireCapture(input.captureId);
    await record.released;
    if (record.status !== "commissioned") {
      throw new InputOperatorError("input_operator_not_commissioned", "A failed or timed-out capture grants no write authority.");
    }
    const value = validateValue(record.action, input.value);
    const routeValue = "text" in value
      ? value
      : { selectedKeys: value.selected.map(({ key }) => key) };
    await this.#withWriteFence(async () => {
      let expectedRevision = input.expectedRevision;
      if (expectedRevision === undefined) {
        const currentDraft = await this.#transport.request(
          `/api/threads/${encodeURIComponent(String(this.authority.threadId))}/input-draft`,
          { method: "GET" },
        );
        if (!isDraftResponse(currentDraft)) {
          throw new InputOperatorError("input_operator_response_invalid", "The product returned an invalid input-draft revision.");
        }
        expectedRevision = currentDraft.revision;
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new InputOperatorError("input_operator_revision_invalid", "Expected input-draft revision must be a non-negative integer.");
      }
      const draft = await this.#transport.request(
        `/api/threads/${encodeURIComponent(String(this.authority.threadId))}/input-draft/attachments`,
        {
          method: "PUT",
          body: {
            occurrence: structuredClone(record.occurrence),
            value: routeValue,
            expectedRevision,
          },
        },
      );
      if (!isDraftResponse(draft)) {
        throw new InputOperatorError("input_operator_response_invalid", "The product returned an invalid input-draft revision.");
      }
      if (!draftContainsCommit(draft, record, routeValue)) {
        throw new InputOperatorError(
          "input_operator_commit_unobserved",
          "The product did not return the exact committed occurrence, action, value, and draft revision.",
        );
      }
      this.#committedDraftRevision = draft.revision;
    });
    record.status = "consumed";
    return this.#committedDraftRevision!;
  }

  async send(input: {
    readonly inputId?: string;
    readonly text?: string;
    readonly modelSelection?: Readonly<Record<string, unknown>>;
  }): Promise<unknown> {
    const inputId = input.inputId ?? this.#createId();
    if (!inputId.trim()) {
      throw new InputOperatorError("input_operator_input_id_required", "Send requires a stable input identity.");
    }
    const revision = this.#committedDraftRevision;
    if (revision === null) {
      throw new InputOperatorError("input_operator_commit_required", "At least one commissioned input must be committed before Send.");
    }
    await this.#waitForCaptureRelease();
    const response = await this.#withWriteFence(() => this.#transport.request(
      `/api/threads/${encodeURIComponent(String(this.authority.threadId))}/interactions`,
      {
        method: "POST",
        body: {
          text: input.text ?? "",
          inputId,
          inputDraftRevision: revision,
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        },
      },
    ));
    this.#committedDraftRevision = null;
    return response;
  }

  state(): InputOperatorState {
    const activeCaptureIds = [...this.#activeCaptureIds];
    return {
      activeCaptureId: activeCaptureIds[0] ?? null,
      activeCaptureIds,
      writeInFlight: this.#writeInFlight,
      captures: [...this.#captures.values()].map((record) => ({
        captureId: record.captureId,
        status: record.status,
        threadRevision: record.threadRevision,
        ratingId: record.ratingId,
        failure: record.failure,
      })),
      committedDraftRevision: this.#committedDraftRevision,
    };
  }

  #requireCapture(captureId: string): CaptureRecord {
    const record = this.#captures.get(captureId);
    if (record === undefined) throw new InputOperatorError("input_operator_capture_unknown", "Unknown input-action capture.");
    return record;
  }

  #failCapture(record: CaptureRecord, failure: "capture_failed" | "capture_timeout"): void {
    if (record.status !== "capturing") return;
    record.status = "failed";
    record.failure = failure;
    this.#releaseCapture(record);
  }

  #releaseCapture(record: CaptureRecord): void {
    if (record.timeout !== null) clearTimeout(record.timeout);
    record.timeout = null;
    this.#activeCaptureIds.delete(record.captureId);
    record.release();
  }

  async #waitForCaptureRelease(): Promise<void> {
    const active = [...this.#activeCaptureIds].map((captureId) => this.#captures.get(captureId)!.released);
    await Promise.all(active);
  }

  async #withWriteFence<Output>(write: () => Promise<Output>): Promise<Output> {
    await this.#waitForCaptureRelease();
    if (this.#writeInFlight) {
      throw new InputOperatorError("input_operator_write_active", "Only one operator write may be in flight.");
    }
    this.#writeInFlight = true;
    try {
      return await write();
    } finally {
      this.#writeInFlight = false;
    }
  }
}

function sameOccurrence(left: InputOccurrenceSnapshot, right: InputOccurrenceSnapshot): boolean {
  return left.presentingInteractionNodeId === right.presentingInteractionNodeId
    && left.presentingLayerId === right.presentingLayerId
    && left.actionId === right.actionId;
}

function validateValue(action: InputActionSnapshot, value: InputOperatorValue): ProductInputValue {
  if (action.control === "text") {
    if (!("text" in value) || value.text.trim() === "") {
      throw new InputOperatorError("input_text_blank", "Enter non-whitespace text for the authored text input.");
    }
    return { text: value.text };
  }
  if (!("selectedKeys" in value)) {
    throw new InputOperatorError("input_action_snapshot_mismatch", "Select option keys for an authored select input.");
  }
  const selectedKeys = [...value.selectedKeys];
  if (new Set(selectedKeys).size !== selectedKeys.length) {
    throw new InputOperatorError("input_option_duplicate", "Remove repeated selected option keys.");
  }
  const options = new Map(action.options.map((option) => [option.key, option]));
  const selected = selectedKeys.map((key) => {
    const option = options.get(key);
    if (option === undefined) throw new InputOperatorError("input_option_unknown", `Unknown option key: ${key}`);
    return structuredClone(option);
  });
  const countValid = action.control === "single_select"
    ? selected.length === 1
    : action.minimumSelections === undefined || selected.length >= action.minimumSelections;
  if (!countValid) {
    throw new InputOperatorError("input_selection_count", "Meet the authored exact selection count or minimum.");
  }
  selected.sort((left, right) => Buffer.from(left.key).compare(Buffer.from(right.key)));
  return { selected };
}

function validateOccurrence(occurrence: InputOccurrenceSnapshot): void {
  if ([occurrence.presentingInteractionNodeId, occurrence.presentingLayerId, occurrence.actionId]
    .some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new InputOperatorError("input_operator_occurrence_invalid", "Input occurrence IDs must be positive safe integers.");
  }
}

function validateActionSnapshot(action: InputActionSnapshot): void {
  if (!action.prompt.trim()) throw new InputOperatorError("input_action_prompt_required", "Input action prompt is required.");
  if (action.control === "text") return;
  if (!action.options.length) throw new InputOperatorError("input_action_options_required", "Select actions require immutable options.");
  const keys = action.options.map(({ key }) => key);
  if (new Set(keys).size !== keys.length) throw new InputOperatorError("input_action_option_key_duplicate", "Input option keys must be unique.");
  if (action.control === "multi_select" && action.minimumSelections !== undefined && (
    !Number.isSafeInteger(action.minimumSelections)
    || action.minimumSelections < 1
    || action.minimumSelections > action.options.length
  )) throw new InputOperatorError("input_action_minimum_invalid", "Multi-select minimum is outside the authored option set.");
}

function isDraftResponse(value: unknown): value is {
  readonly revision: number;
  readonly attachments?: readonly Readonly<Record<string, unknown>>[];
} {
  if (typeof value !== "object" || value === null || !("revision" in value)) return false;
  const revision = value.revision;
  return Number.isSafeInteger(revision) && (revision as number) >= 0;
}

function draftContainsCommit(
  draft: { readonly revision: number; readonly attachments?: readonly Readonly<Record<string, unknown>>[] },
  record: CaptureRecord,
  value: { readonly text: string } | { readonly selectedKeys: readonly string[] },
): boolean {
  if (!Array.isArray(draft.attachments)) return false;
  const expectedAction = record.action.control === "text"
    ? { control: record.action.control, prompt: record.action.prompt }
    : {
        control: record.action.control,
        prompt: record.action.prompt,
        options: record.action.options,
        ...(record.action.control === "multi_select" && record.action.minimumSelections !== undefined
          ? { minimumSelections: record.action.minimumSelections }
          : {}),
      };
  return draft.attachments.some((attachment) => (
    canonicalJson(attachment.occurrence) === canonicalJson(record.occurrence)
    && canonicalJson(attachment.action) === canonicalJson(expectedAction)
    && canonicalJson(attachment.value) === canonicalJson(value)
    && attachment.draftRevision === draft.revision
  ));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
