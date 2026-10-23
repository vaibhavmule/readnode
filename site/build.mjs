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
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

function withAnchors(html) {
  const headings = [];
  const seen = new Map();
  const body = html.replace(
    /<h([23])>(.*?)<\/h\1>/g,
    (match, level, inner) => {
      const base = slug(inner.replace(/<[^>]+>/g, "")) || "section";
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      const id = count ? `${base}-${count}` : base;
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

async function render({ source, out, lang, title, tagline, strings }) {
  const markdown = await readFile(join(root, source), "utf8");
  const rendered = marked.parse(markdown);
  const { body, headings } = withAnchors(rendered);
  const template = await readFile(join(here, "template.html"), "utf8");

  const html = template
    .replaceAll("{{title}}", title)
    .replaceAll("{{tagline}}", tagline)
    .replaceAll("{{lang}}", lang)
    .replaceAll("{{toc}}", sidebar(headings))
    .replaceAll("{{quickstartId}}", escapeAttr(headings[0]?.id ?? ""))
    .replace(/\{\{(\w+)\}\}/g, (match, key) => strings[key] ?? match)
    .replace("{{content}}", () => body);

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
    strings: {
      assets: "",
      eyebrow: "Farcaster · Snapchain · no API keys",
      quickstart: "Quickstart",
      repo: "GitHub repo",
      switchHref: "zh/index.html",
      switchLang: "zh-CN",
      switchLabel: "中文",
      contents: "Contents",
      footer: "MIT licensed. Run it against a test account.",
    },
  }),
  render({
    source: "docs/tutorial.zh-CN.md",
    out: "zh",
    lang: "zh-CN",
    tagline: "搭一个你自己的 Snapchain 读取节点，再用一个从该节点读取的客户端。",
    title: "从你自己的 Farcaster 节点读取数据",
    strings: {
      assets: "../",
      eyebrow: "Farcaster · Snapchain · 无需 API 密钥",
      quickstart: "快速开始",
      repo: "GitHub 仓库",
      switchHref: "../index.html",
      switchLang: "en",
      switchLabel: "English",
      contents: "目录",
      footer: "MIT 许可。请用测试账号运行。",
    },
  }),
  render({
    source: "docs/proof.md",
    out: "proof",
    lang: "en",
    title: "Proof: what we ran",
    tagline: "One real mainnet run: provisioned, synced in 19 h 18 m, and posted through our own node.",
    strings: {
      assets: "../",
      eyebrow: "readnode · mainnet run · Oct 22–23, 2026",
      quickstart: "Summary",
      repo: "GitHub repo",
      switchHref: "../index.html",
      switchLang: "en",
      switchLabel: "Tutorial",
      contents: "Contents",
      footer: "MIT licensed. Run it against a test account.",
    },
  }),
]);

for (const output of outputs) {
  process.stdout.write(`site: ${output.out} (${output.headings} headings)\n`);
}
