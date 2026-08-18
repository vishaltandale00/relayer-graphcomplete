const ALLOWED_MARKDOWN_ELEMENTS = new Set([
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4",
  "hr", "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "th",
  "thead", "tr", "ul",
]);

const DANGEROUS_MARKDOWN_ELEMENTS = new Set([
  "iframe", "math", "object", "script", "style", "svg", "template",
]);

export function isSafeMarkdownLink(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function appendSanitizedNode(source, target, ownerDocument) {
  if (source.nodeType === 3) {
    target.append(ownerDocument.createTextNode(source.data));
    return;
  }
  if (source.nodeType !== 1) return;

  const tagName = source.tagName.toLowerCase();
  if (DANGEROUS_MARKDOWN_ELEMENTS.has(tagName)) return;
  if (!ALLOWED_MARKDOWN_ELEMENTS.has(tagName)) {
    for (const child of source.childNodes) appendSanitizedNode(child, target, ownerDocument);
    return;
  }

  const element = ownerDocument.createElement(tagName);
  if (tagName === "a") {
    const href = source.getAttribute("href");
    if (href && isSafeMarkdownLink(href)) {
      element.setAttribute("href", href);
      element.setAttribute("rel", "noreferrer noopener");
    }
    const title = source.getAttribute("title");
    if (title) element.setAttribute("title", title);
  }
  for (const child of source.childNodes) appendSanitizedNode(child, element, ownerDocument);
  target.append(element);
}

export function renderMarkdown(element, value) {
  const markdown = String(value ?? "");
  const parse = globalThis.marked?.parse;
  if (typeof parse !== "function" || typeof DOMParser !== "function") {
    element.textContent = markdown;
    return;
  }

  try {
    const rendered = parse(markdown, { async: false, gfm: true });
    if (typeof rendered !== "string") throw new Error("Markdown parser returned an asynchronous result.");
    const parsed = new DOMParser().parseFromString(rendered, "text/html");
    const fragment = element.ownerDocument.createDocumentFragment();
    for (const child of parsed.body.childNodes) {
      appendSanitizedNode(child, fragment, element.ownerDocument);
    }
    element.replaceChildren(fragment);
  } catch {
    element.textContent = markdown;
  }
}
