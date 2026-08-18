import { readFile } from "node:fs/promises";

const MAX_WORDS = 25;
const SOURCE_URL = new URL("./index.html", import.meta.url);
const CHECKED_ELEMENTS = ["p", "li", "td", "figcaption"];

const html = await readFile(SOURCE_URL, "utf8");
const mainStart = html.indexOf("<main>");
const mainEnd = html.indexOf("</main>");

if (mainStart === -1 || mainEnd === -1) {
  throw new Error("The PRD must contain one <main> element.");
}

const main = html.slice(mainStart, mainEnd);
const violations = [];

for (const tag of CHECKED_ELEMENTS) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g");
  let elementNumber = 0;

  for (const match of main.matchAll(pattern)) {
    elementNumber += 1;
    const text = match[1]
      .replace(/<code[\s\S]*?<\/code>/gi, " identifier ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&(?:#39|quot|amp|lt|gt|hellip|rarr);/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    for (const sentence of text.split(/(?<=[.!?])\s+(?=[A-Z0-9“])/)) {
      const wordCount = sentence.match(/[A-Za-z0-9][A-Za-z0-9’'/-]*/g)?.length ?? 0;
      if (wordCount > MAX_WORDS) {
        violations.push({ tag, elementNumber, wordCount, sentence });
      }
    }
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(
      `${violation.tag} ${violation.elementNumber}: ${violation.wordCount} words: ${violation.sentence}`,
    );
  }
  process.exitCode = 1;
} else {
  console.log(`PRD readability check passed. No checked sentence has more than ${MAX_WORDS} words.`);
}
