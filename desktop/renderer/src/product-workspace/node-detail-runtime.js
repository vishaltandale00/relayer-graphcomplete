const SAFE_ASSET_MEDIA_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
]);
const SAFE_RUNTIME_ELEMENTS = new Set([
  "a", "abbr", "article", "aside", "b", "bdi", "bdo", "blockquote", "br", "button", "caption", "cite", "code",
  "col", "colgroup", "data", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "fieldset", "figcaption",
  "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "i", "img", "input",
  "ins", "kbd", "label", "legend", "li", "main", "mark", "menu", "meter", "nav", "ol", "p", "pre", "q", "rp",
  "rt", "ruby", "s", "samp", "section", "select", "small", "span", "strong", "sub", "summary", "sup", "table",
  "tbody", "td", "textarea", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
]);
const INTERACTIVE_RUNTIME_ELEMENTS = new Set(["a", "button", "input", "select", "textarea"]);
const GLOBAL_RUNTIME_ATTRIBUTES = new Set([
  "class", "id", "lang", "dir", "role", "title",
  "aria-label", "aria-labelledby", "aria-describedby", "aria-hidden", "aria-current",
  "data-gc-mount", "data-asset-mount",
]);
const ELEMENT_RUNTIME_ATTRIBUTES = Object.freeze({
  col: new Set(["span"]), colgroup: new Set(["span"]), data: new Set(["value"]),
  img: new Set(["alt", "height", "width"]), input: new Set(["type"]), label: new Set(["for"]),
  meter: new Set(["min", "max", "low", "high", "optimum", "value"]),
  ol: new Set(["reversed", "start", "type"]), select: new Set(["multiple"]),
  td: new Set(["colspan", "rowspan", "headers"]),
  th: new Set(["colspan", "rowspan", "headers", "scope", "abbr"]), time: new Set(["datetime"]),
});
const UNSAFE_CSS_RESOURCE_FUNCTION = /(?:\burl|\bimage|\bimage-set|\bcross-fade|\belement|\bpaint)\s*\(/i;

function decodeCssEscapes(value) {
  return value.replace(/\\([0-9a-f]{1,6})(?:\s)?|\\(.)/gi, (_match, hex, escaped) => {
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
    return escaped ?? "";
  });
}

function cssStructureIsClosed(source) {
  const stack = [];
  let quote = null;
  let comment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (comment) {
      if (character === "*" && next === "/") {
        comment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "*") {
      comment = true;
      index += 1;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "\\") {
      const escaped = source.slice(index + 1).match(/^[0-9a-f]{1,6}(?:\s)?|^[\s\S]/i)?.[0] ?? "";
      index += escaped.length;
    } else if (character === "{" || character === "(" || character === "[") {
      stack.push(character);
    } else if (character === "}" || character === ")" || character === "]") {
      const expected = character === "}" ? "{" : character === ")" ? "(" : "[";
      if (stack.pop() !== expected) return false;
    }
  }
  return !comment && quote === null && stack.length === 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function packageContent(detail) {
  return {
    version: detail.version,
    components: detail.components,
    mounts: detail.mounts,
    assets: detail.assets,
  };
}

async function sha256Hex(value, crypto) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function assertCanonicalPackage(detail, crypto) {
  if (detail?.version !== 1
    || !Array.isArray(detail.components)
    || !Array.isArray(detail.mounts)
    || !Array.isArray(detail.assets)
    || !/^[a-f0-9]{64}$/.test(detail.integritySha256 || "")) {
    throw new Error("Node Detail package is invalid.");
  }
  const actual = await sha256Hex(canonicalJson(packageContent(detail)), crypto);
  if (actual !== detail.integritySha256) throw new Error("Node Detail package integrity check failed.");
}

function mountIndex(detail) {
  const mounts = new Map();
  for (const mount of detail.mounts) {
    if (typeof mount?.id !== "string" || mounts.has(mount.id)) {
      throw new Error("Node Detail package contains an invalid mount identity.");
    }
    mounts.set(mount.id, mount);
  }
  return mounts;
}

function assertSafeComponent(component, fragment, mounts) {
  const decodedCss = typeof component.css === "string" ? decodeCssEscapes(component.css) : "";
  if (typeof component.css !== "string"
    || !cssStructureIsClosed(component.css)
    || /(?:@import|\bexpression\s*\()/i.test(decodedCss)
    || UNSAFE_CSS_RESOURCE_FUNCTION.test(decodedCss)) {
    throw new Error("Node Detail package contains unsafe runtime markup.");
  }
  for (const element of fragment.querySelectorAll("*")) {
    const capabilityId = element.getAttribute("data-gc-mount");
    const assetId = element.getAttribute("data-asset-mount");
    const unsafeAttribute = [...element.attributes].some((attribute) => !(
      GLOBAL_RUNTIME_ATTRIBUTES.has(attribute.name)
      || ELEMENT_RUNTIME_ATTRIBUTES[element.localName]?.has(attribute.name) === true
    ));
    const compiledMount = capabilityId ? mounts.get(capabilityId) : assetId ? mounts.get(assetId) : undefined;
    const interactiveWithoutMount = INTERACTIVE_RUNTIME_ELEMENTS.has(element.localName) && capabilityId === null;
    const imageWithoutMount = element.localName === "img" && assetId === null;
    if (!SAFE_RUNTIME_ELEMENTS.has(element.localName)
      || unsafeAttribute
      || interactiveWithoutMount
      || imageWithoutMount
      || (capabilityId !== null && assetId !== null)
      || ((capabilityId !== null || assetId !== null) && compiledMount === undefined)
      || (compiledMount !== undefined && compiledMount.componentId !== component.id)
      || (compiledMount !== undefined && compiledMount.host !== element.localName)
      || (capabilityId !== null && compiledMount?.kind !== "capability")
      || (assetId !== null && compiledMount?.kind !== "asset")) {
      throw new Error("Node Detail package contains unsafe runtime markup.");
    }
  }
}

function applyLink(host, capability) {
  if (host.localName !== "a" || capability?.kind !== "link") {
    throw new Error("Node Detail link mount has an incompatible host.");
  }
  const target = new URL(capability.href);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Node Detail link destination is unsafe.");
  }
  host.setAttribute("href", target.href);
  host.setAttribute("target", "_blank");
  host.setAttribute("rel", "noreferrer noopener");
}

function initialCapabilityState(capabilityState, mountId) {
  if (capabilityState instanceof Map) return capabilityState.get(mountId) ?? {};
  return capabilityState?.[mountId] ?? {};
}

function applyCapabilityState(host, state = {}) {
  host.disabled = state.disabled === true || state.busy === true;
  host.setAttribute("aria-disabled", String(host.disabled));
  host.setAttribute("aria-busy", String(state.busy === true));
  host.dataset.capabilityState = state.busy === true ? "busy" : host.disabled ? "disabled" : "ready";
  if (state.error) {
    if (host.dataset.relayerAuthoredTitle === undefined) {
      host.dataset.relayerAuthoredTitle = host.getAttribute("title") ?? "";
    }
    host.setAttribute("aria-invalid", "true");
    host.setAttribute("title", String(state.error));
  } else {
    host.removeAttribute("aria-invalid");
    if (host.dataset.relayerAuthoredTitle !== undefined) {
      const authoredTitle = host.dataset.relayerAuthoredTitle;
      delete host.dataset.relayerAuthoredTitle;
      if (authoredTitle) host.setAttribute("title", authoredTitle);
      else host.removeAttribute("title");
    }
  }
  if (host.localName === "select" && Array.isArray(state.value)) {
    const selected = new Set(state.value.map(String));
    for (const option of host.options) option.selected = selected.has(option.value);
  } else if ((host.localName === "input" || host.localName === "textarea")
    && typeof state.value === "string") {
    host.value = state.value;
  }
}

function assertResolvedAction(capability, action) {
  if (!action || typeof action !== "object") throw new Error(`Node Detail ${capability.kind} action is unavailable.`);
  if (capability.kind === "invoke" && action.kind !== "invoke") {
    throw new Error("Node Detail invoke authority did not resolve an invoke action.");
  }
  if ((capability.kind === "expand" || capability.kind === "reference")
    && (action.kind !== "navigate" || action.relation !== capability.kind || action.targetLayerId == null)) {
    throw new Error(`Node Detail ${capability.kind} authority did not resolve matching navigation.`);
  }
  if (capability.kind === "input" && action.kind !== "input") {
    throw new Error("Node Detail input authority did not resolve an input action.");
  }
}

function applyUnavailableCapability(host, message) {
  host.dataset.capabilityState = "unavailable";
  host.setAttribute("aria-disabled", "true");
  host.setAttribute("aria-invalid", "true");
  host.setAttribute("title", message);
  host.disabled = true;
}

function activateGraphHost(host, activation) {
  if (host.localName !== "a" && host.localName !== "button") {
    throw new Error("Node Detail graph action mount has an incompatible host.");
  }
  if (host.localName === "button") host.type = "button";
  if (host.localName === "a") {
    host.setAttribute("role", "button");
    host.tabIndex = 0;
  }
  host.addEventListener("click", (event) => {
    event.preventDefault();
    if (!host.disabled && host.getAttribute("aria-disabled") !== "true") void activation();
  });
  if (host.localName === "a") {
    host.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && host.getAttribute("aria-disabled") !== "true") {
        event.preventDefault();
        void activation();
      }
    });
  }
}

function assertPotentialInputHost(host) {
  if (host.localName !== "input" && host.localName !== "select" && host.localName !== "textarea") {
    throw new Error("Node Detail input mount has an incompatible host.");
  }
}

function configureInput(host, action, resolveCurrentAction, onInput, context) {
  if (action.control === "text" && host.localName !== "input" && host.localName !== "textarea") {
    throw new Error("Node Detail text input has an incompatible host.");
  }
  if ((action.control === "single_select" || action.control === "multi_select") && host.localName !== "select") {
    throw new Error("Node Detail selection input has an incompatible host.");
  }
  if (host.localName === "select") {
    host.multiple = action.control === "multi_select";
    host.replaceChildren(...(action.options || []).map((item) => {
      const option = host.ownerDocument.createElement("option");
      option.value = String(item.key);
      option.textContent = String(item.label);
      return option;
    }));
  }
  const submit = async () => {
    try {
      const value = host.localName === "select"
        ? [...host.selectedOptions].map((option) => option.value)
        : host.value;
      const currentAction = await resolveCurrentAction();
      assertResolvedAction(context.capability, currentAction);
      await onInput(currentAction, value, context);
    } catch (error) {
      applyUnavailableCapability(host, error?.message || "Node Detail input action is unavailable.");
    }
  };
  host.addEventListener("change", () => { void submit(); });
}

function assetFallback(host) {
  host.removeAttribute("src");
  host.style.removeProperty("background-image");
  host.dataset.assetState = "unavailable";
  host.classList.add("relayer-asset-unavailable");
  host.setAttribute("title", "Visual unavailable");
}

function assertImageMount(host, asset) {
  if ((host.localName !== "img" && host.localName !== "span")
    || asset?.representation !== "image"
    || !SAFE_ASSET_MEDIA_TYPES.has(asset.mediaType)) {
    throw new Error("Node Detail asset mount has an unsupported representation.");
  }
}

async function applyImage(host, asset, resolveAsset) {
  assertImageMount(host, asset);
  let resolved;
  try {
    resolved = await resolveAsset(asset);
    const source = new URL(resolved?.url);
    if (resolved?.digestSha256 !== asset.digestSha256
      || resolved?.mediaType !== asset.mediaType
      || source.protocol !== "blob:") {
      throw new Error("Visual asset resolution did not match the pinned package.");
    }
    if (host.localName === "img") {
      host.addEventListener("error", () => assetFallback(host), { once: true });
      host.setAttribute("src", source.href);
    }
    else host.style.backgroundImage = `url("${source.href.replaceAll('"', "%22")}")`;
    host.dataset.assetState = "available";
  } catch {
    assetFallback(host);
  }
}

function renderFallback(host, message) {
  const surface = host.shadowRoot ?? host;
  surface.replaceChildren();
  const fallback = host.ownerDocument.createElement("p");
  fallback.className = "node-detail-runtime-fallback";
  fallback.setAttribute("role", "status");
  fallback.textContent = message;
  surface.append(fallback);
  return Object.freeze({ status: "fallback", error: message });
}

export async function mountCompiledNodeDetail({
  host,
  detail,
  resolveAsset = async () => undefined,
  resolveAction = async () => undefined,
  onNavigate = async () => undefined,
  onInvoke = async () => undefined,
  onInput = async () => undefined,
  capabilityState = {},
}) {
  const assetReleases = [];
  try {
    if (!host?.ownerDocument || typeof host.attachShadow !== "function") {
      throw new Error("Node Detail runtime requires a browser host.");
    }
    const crypto = host.ownerDocument.defaultView?.crypto ?? globalThis.crypto;
    if (!crypto?.subtle) throw new Error("Node Detail integrity verification is unavailable.");
    await assertCanonicalPackage(detail, crypto);
    const mounts = mountIndex(detail);
    const components = [...detail.components].sort((left, right) => left.order - right.order);
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadow.replaceChildren();
    const authoredStyles = host.ownerDocument.createElement("style");
    authoredStyles.dataset.nodeDetailAuthoredStyles = "";
    authoredStyles.textContent = components.map((component) => component.css).join("\n");
    const runtimeStyles = host.ownerDocument.createElement("style");
    runtimeStyles.dataset.nodeDetailRuntimeStyles = "";
    runtimeStyles.textContent = `:host{display:block!important;position:relative!important;inline-size:100%!important;min-width:0!important;max-width:100%!important;contain:layout paint style!important;isolation:isolate!important;overflow:hidden!important;color:inherit;font:inherit;overflow-wrap:anywhere}
*,*::before,*::after{box-sizing:border-box;min-inline-size:0}
img{max-inline-size:100%}
.relayer-asset-unavailable{background-image:none!important}`;
    shadow.append(authoredStyles, runtimeStyles);
    for (const component of components) {
      const template = host.ownerDocument.createElement("template");
      template.innerHTML = component.html;
      assertSafeComponent(component, template.content, mounts);
      shadow.append(template.content.cloneNode(true));
    }

    for (const [id, mount] of mounts) {
      const attribute = mount.kind === "capability" ? "data-gc-mount" : "data-asset-mount";
      const occurrences = [...shadow.querySelectorAll(`[${attribute}]`)]
        .filter((candidate) => candidate.getAttribute(attribute) === id);
      if (occurrences.length !== 1) {
        throw new Error(`Node Detail mount ${id} must occur exactly once.`);
      }
    }

    const assetById = new Map(detail.assets.map((asset) => [asset.id, asset]));
    const assetWork = [];
    const capabilityHosts = new Map();
    const capabilityStates = new Map();
    const capabilityRecords = new Map();
    const configuredCapabilities = new Set();
    const adapters = { resolveAction, onNavigate, onInvoke, onInput };
    const configureCapability = (id, element, capability, action, resolveCurrentAction) => {
      if (configuredCapabilities.has(id)) return;
      const context = Object.freeze({ mountId: id, capability, actionReference: capability.action });
      if (capability.kind === "input") {
        configureInput(element, action, resolveCurrentAction, (...args) => adapters.onInput(...args), context);
      } else {
        activateGraphHost(element, async () => {
          const prior = capabilityStates.get(id) ?? {};
          applyCapabilityState(element, { ...prior, busy: true });
          try {
            const currentAction = await resolveCurrentAction();
            assertResolvedAction(capability, currentAction);
            if (capability.kind === "invoke") await adapters.onInvoke(currentAction, context);
            else await adapters.onNavigate(currentAction, Object.freeze({ ...context, relation: capability.kind }));
            if (capability.kind === "invoke" && currentAction.targetLayerId == null) {
              capabilityStates.set(id, { ...prior, disabled: true, busy: false });
            }
          } catch (error) {
            capabilityStates.set(id, {
              ...prior,
              busy: false,
              error: error?.message || `Node Detail ${capability.kind} action failed.`,
            });
          } finally {
            applyCapabilityState(element, capabilityStates.get(id) ?? prior);
          }
        });
      }
      configuredCapabilities.add(id);
      const state = capabilityStates.get(id) ?? initialCapabilityState(capabilityState, id);
      capabilityStates.set(id, state);
      applyCapabilityState(element, state);
    };
    for (const [id, mount] of mounts) {
      const attribute = mount.kind === "capability" ? "data-gc-mount" : "data-asset-mount";
      const element = [...shadow.querySelectorAll(`[${attribute}]`)]
        .find((candidate) => candidate.getAttribute(attribute) === id);
      if (!element || element.localName !== mount.host) {
        throw new Error(`Node Detail mount ${id} does not match its compiled host.`);
      }
      if (mount.kind === "capability") {
        const capability = mount.capability;
        if (capability.kind === "link") {
          applyLink(element, capability);
          capabilityHosts.set(id, element);
          continue;
        }
        if (capability.kind === "input") assertPotentialInputHost(element);
        else if (element.localName !== "a" && element.localName !== "button") {
          throw new Error("Node Detail graph action mount has an incompatible host.");
        }
        const resolveCurrentAction = () => adapters.resolveAction(capability.action, capability.kind);
        capabilityRecords.set(id, { element, capability, resolveCurrentAction });
        const action = await resolveCurrentAction();
        try {
          assertResolvedAction(capability, action);
        } catch (error) {
          applyUnavailableCapability(element, error.message);
          capabilityHosts.set(id, element);
          capabilityStates.set(id, { disabled: true, error: error.message });
          continue;
        }
        configureCapability(id, element, capability, action, resolveCurrentAction);
        capabilityHosts.set(id, element);
      } else {
        const asset = assetById.get(mount.assetId);
        assertImageMount(element, asset);
        assetWork.push(() => applyImage(element, asset, async (requestedAsset) => {
          const resolved = await resolveAsset(requestedAsset);
          if (typeof resolved?.release === "function") assetReleases.push(resolved.release);
          return resolved;
        }));
      }
    }
    await Promise.all(assetWork.map((work) => work()));
    return Object.freeze({
      status: "mounted",
      shadowRoot: shadow,
      updateCapability(mountId, state) {
        const capabilityHost = capabilityHosts.get(mountId);
        if (!capabilityHost) return false;
        capabilityStates.set(mountId, { ...(capabilityStates.get(mountId) ?? {}), ...state });
        applyCapabilityState(capabilityHost, capabilityStates.get(mountId));
        return true;
      },
      async updateAdapters(next) {
        Object.assign(adapters, next);
        for (const [id, record] of capabilityRecords) {
          if (configuredCapabilities.has(id)) continue;
          const action = await record.resolveCurrentAction();
          try {
            assertResolvedAction(record.capability, action);
          } catch {
            continue;
          }
          capabilityStates.set(id, {
            ...(capabilityStates.get(id) ?? {}),
            disabled: false,
            busy: false,
            error: null,
          });
          configureCapability(id, record.element, record.capability, action, record.resolveCurrentAction);
        }
      },
      dispose() {
        for (const release of assetReleases.splice(0)) {
          try { release(); } catch { /* The resolver owns release diagnostics. */ }
        }
        shadow.replaceChildren();
      },
    });
  } catch (error) {
    for (const release of assetReleases.splice(0)) {
      try { release(); } catch { /* Preserve the deterministic renderer fallback. */ }
    }
    return renderFallback(host, error?.message || "Node Detail could not be displayed.");
  }
}
