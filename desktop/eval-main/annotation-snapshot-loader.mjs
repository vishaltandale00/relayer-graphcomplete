export async function loadAtomicAnnotationSnapshots({
  session,
  threadIds,
  token,
  authorId,
  authorDisplayName,
  fetchImpl = fetch,
}) {
  const controlCookie = `${session.cookie.name}=${session.cookie.value}`;
  const registration = await fetchImpl(new URL("/api/internal/annotation-sessions", session.origin), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: controlCookie },
    body: JSON.stringify({ token, threadIds, authorId, authorDisplayName }),
  });
  if (!registration.ok) {
    const value = await registration.json().catch(() => ({}));
    throw new Error(value?.error || `Annotation export session failed (${registration.status}).`);
  }
  try {
    const response = await fetchImpl(new URL("/api/annotations/snapshot", session.origin), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: `${controlCookie}; relayer_annotation=${token}`,
      },
      body: JSON.stringify({ threadIds }),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(value?.error || `Annotation snapshot failed (${response.status}).`);
    }
    return value;
  } finally {
    const revocation = await fetchImpl(new URL("/api/internal/annotation-sessions", session.origin), {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: controlCookie,
      },
      body: JSON.stringify({ token }),
    });
    if (!revocation.ok) {
      const value = await revocation.json().catch(() => ({}));
      throw new Error(value?.error || `Annotation export session revocation failed (${revocation.status}).`);
    }
  }
}
