/** Product request authenticated with the loopback session cookie. */
export async function productRequest(session, path, options = {}) {
  const response = await fetch(new URL(path, session.origin), {
    ...options,
    headers: {
      ...options.headers,
      Cookie: `${session.cookie.name}=${session.cookie.value}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${JSON.stringify(value)}`);
  }
  return value;
}

/** Read trusted invocation provenance for every completion observed by the product. */
export async function completionMetadata(runtimeSession, completionIds) {
  return Promise.all([...completionIds].map(async (completionId) => {
    const response = await fetch(new URL(
      `api/control/interactions/${completionId}`,
      `${runtimeSession.graphUrl}/`,
    ), {
      headers: { authorization: `Bearer ${runtimeSession.graphControlToken}` },
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`graph metadata ${completionId} failed (${response.status}): ${JSON.stringify(value)}`);
    }
    return value;
  }));
}
