import { inputOccurrenceKey } from "./node-input-controls.js";

const valueKey = value => JSON.stringify(Array.isArray(value?.selected)
  ? { selected: value.selected.map(({ key, label }) => ({ key, label })).sort((a, b) => a.key.localeCompare(b.key)) }
  : value);

// An unanswered network request keeps its exact key and frozen input. Reopening
// reads graph-owned receipts; this controller never starts or resumes inference.
export function createLiveAnswerController({ api, newKey = () => crypto.randomUUID() }) {
  const slots = new Map();
  const slotKey = (threadId, occurrence) => `${threadId}:${inputOccurrenceKey(occurrence)}`;
  return Object.freeze({
    receipt: (threadId, occurrence) => slots.get(slotKey(threadId, occurrence))?.receipt ?? null,
    async answer(threadId, interactionId, input, value) {
      const key = slotKey(threadId, input.occurrence);
      let slot = slots.get(key);
      if (slot?.receipt) {
        if (valueKey(slot.request.value) !== valueKey(value)) throw new Error("This question already has a delivered answer.");
        return slot.receipt;
      }
      if (slot && valueKey(slot.request.value) !== valueKey(value)) throw new Error("The earlier answer's delivery is unconfirmed. Reopen the question before changing it.");
      if (!slot) {
        slot = { request: structuredClone({ ...input, value, operationKey: newKey() }), receipt: null, pending: null };
        slots.set(key, slot);
      }
      if (slot.pending) return slot.pending;
      const accept = receipt => {
        if (receipt?.operationKey !== slot.request.operationKey || receipt.attemptId !== slot.request.attemptId
          || receipt.completionId !== slot.request.occurrence.presentingInteractionNodeId
          || receipt.authorityEpoch !== slot.request.authorityEpoch || receipt.currentRevision !== slot.request.expectedRevision
          || !Number.isSafeInteger(receipt.sequence) || receipt.sequence <= 0
          || valueKey(receipt.value) !== valueKey(slot.request.value)
          || inputOccurrenceKey(receipt.occurrence) !== inputOccurrenceKey(slot.request.occurrence)) throw new Error("Answer receipt does not match the submitted question.");
        slot.receipt = receipt;
        return receipt;
      };
      slot.pending = (async () => {
        try { return accept(await api.answer(threadId, interactionId, slot.request)); }
        catch (error) {
          if ([400, 403, 404, 409, 422].includes(error.status)) { slots.delete(key); throw error; }
          // A lost response may already have committed. One read reconciles;
          // absence or read failure never authorizes a replacement or replay.
          const page = await api.liveAnswers(threadId, interactionId).catch(() => null);
          const receipt = [...(page?.answers ?? []), ...(page?.currentAnswers ?? [])].find(answer => answer.operationKey === slot.request.operationKey);
          if (receipt) return accept(receipt);
          throw new Error("Answer delivery is unconfirmed. Reopen this question to check its receipt.");
        } finally { slot.pending = null; }
      })();
      return slot.pending;
    },
  });
}
