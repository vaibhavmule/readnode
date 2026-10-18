import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(here, "dist");

marked.setOptions({ gfm: true, headerIds: false, mangle: false });

const escapeAttr = (value) => value.replaceAll('"', "&quot;");
const slug = (value) =>
  value
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

function withAnchors(html) {
  const headings = [];
  const body = html.replace(
    /<h([23])>(.*?)<\/h\1>/g,
    (match, level, inner) => {
      const id = slug(inner.replace(/<[^>]+>/g, ""));
      headings.push({ level: Number(level), id, text: inner.replace(/<[^>]+>/g, "") });
      return `<h${level} id="${escapeAttr(id)}">${inner}</h${level}>`;
    },
  );
  return { body, headings };
}

function sidebar(headings) {
  return headings
    .filter((heading) => heading.level === 2)
    .map(
      (heading) =>
        `<li><a href="#${escapeAttr(heading.id)}">${heading.text}</a></li>`,
    )
    .join("");
}

async function render({ source, out, lang, title, tagline }) {
  const markdown = await readFile(join(root, source), "utf8");
  const rendered = marked.parse(markdown);
  const { body, headings } = withAnchors(rendered);
  const template = await readFile(join(here, "template.html"), "utf8");

  const html = template
    .replaceAll("{{title}}", title)
    .replaceAll("{{tagline}}", tagline)
    .replaceAll("{{lang}}", lang)
    .replaceAll("{{toc}}", sidebar(headings))
    .replace("{{content}}", body);

  await mkdir(join(dist, out), { recursive: true });
  await writeFile(join(dist, out, "index.html"), html, "utf8");
  return { out, headings: headings.length };
}

await mkdir(dist, { recursive: true });
await cp(join(here, "public"), dist, { recursive: true });

const outputs = await Promise.all([
  render({
    source: "docs/tutorial.md",
    out: ".",
    lang: "en",
    title: "Read from your own Farcaster node",
    tagline: "Run a Snapchain read node, then use a client that reads from it.",
  }),
  render({
    source: "docs/tutorial.zh-CN.md",
    out: "zh",
    lang: "zh-CN",
    tagline: "搭一个你自己的 Snapchain 读取节点，再用一个从该节点读取的客户端。",
    title: "从你自己的 Farcaster 节点读取数据",
  }),
]);

for (const output of outputs) {
  process.stdout.write(`site: ${output.out} (${output.headings} headings)\n`);
}
