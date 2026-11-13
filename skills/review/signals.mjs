#!/usr/bin/env node
// Сигналы роста сложности в диффе: где вырос код, какие точки сборки и манифесты задеты, какие экспорты без
// потребителя, какие файлы скопированы и какие конструкции добавлены. Сигнал является вопросом ревьюеру, а не приговором.
// Без аргументов берётся staged, а если он пуст, всё незакоммиченное. Иначе аргументы git diff: `HEAD` (всё
// незакоммиченное, с новыми файлами вне git), `HEAD~1..HEAD`, `main...`. После `--` идут пути: `HEAD -- src/a.ts`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const CODE_FILE =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|astro|py|go|rs|java|kt|kts|swift|rb|php|cs|c|cc|cpp|h|hpp|scala|dart|ex|exs|lua|sh)$/;
const JS_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|astro)$/;
const GENERATED =
  /(^|\/)(generated|__generated__|gen|dist|build|out|vendor|node_modules|\.next|target)\/|\.(gen|g|freezed|generated|designer)\.|_pb2?\.|\.pb\.|\.min\.|(^|\/|-|\.)lock(file)?\.(json|yaml|yml)$|\.lock$/i;
const TEST_FILE =
  /(\.|_)(test|spec)\.\w+$|[a-z0-9](Tests?|Spec)\.\w+$|(^|\/)([Tt]ests?|__tests__|e2e|scenarios|fixtures|mocks?|androidTest|testFixtures)\/|(^|\/)test_\w+\.py$/;
// Каталоги монорепы, где модуль задаёт второй сегмент пути (`packages/core`), а не первый.
const WORKSPACE_DIRS = new Set(["apps", "packages", "libs", "services", "tools", "modules", "crates", "plugins", "cmd"]);
// Точки сборки, store, codec и входы: растут с каждой фичей, расти должны только связыванием.
const HUB_NAME =
  /^(index|main|app|server|client|router|store|actions|registry|mod|lib|__init__|program|urls|appdelegate|mainactivity)\.\w+$/i;
const HUB_PATTERN = /^(create[A-Z]\w*|\w+(Store|Codec|Registry|Router|Context|Provider|Module))\.\w+$|\.module\.\w+$/;
const MANIFEST_FILE =
  /(^|\/)(package\.json|pyproject\.toml|requirements[\w.-]*\.txt|go\.mod|Cargo\.toml|Gemfile|composer\.json|build\.gradle(\.kts)?|pom\.xml|pubspec\.yaml|Package\.swift|Podfile|libs\.versions\.toml|[\w.-]+\.csproj)$/;
const MANIFEST_VERSION = /^[+-]\s*"?version"?\s*[:=]/;
const JS_EXPORT =
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|abstract\s+class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
// `#` считается комментарием только с пробелом: `#private` в TS и `#include` в C являются кодом.
const COMMENT_LINE = /^\s*(\/\/|#(\s|$)|\*|\/\*|--\s)/;
const LARGE_FILE_LINES = 600;
const BIG_GROWTH_LINES = 150;
// Средний файл, выросший на четверть, даёт тот же признак второй ответственности, что и большой рост.
const RELATIVE_GROWTH = 0.25;
const RELATIVE_GROWTH_LINES = 60;
const EXAMPLES_PER_SIGNAL = 6;
const MAX_EXPORTS_CHECKED = 200;
const MAX_MANIFEST_LINES = 40;
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

// `inComments`: сигнал ищется и в комментариях; остальные комментарии пропускают.
const RISKY_ADDITIONS = [
  { name: "необязательное поле или параметр `?:`, `Optional`", pattern: /\w\?:|\bOptional\[/ },
  { name: "`| undefined`, `| null`", pattern: /\|\s*(undefined|null)\b/ },
  { name: "значение по умолчанию вместо контракта (`?? []`, `|| 0`)", pattern: /(\?\?|\|\|)\s*(\[\]|\{\}|0|""|''|null|undefined|false)(?![\w.])/ },
  {
    name: "проверка типа в рантайме (`instanceof`, `isinstance`, `typeof x ===`)",
    pattern: /\binstanceof\b|\bisinstance\(|typeof \w+ ===/,
  },
  {
    name: "приведение типа (`as`, `cast`, `any`)",
    pattern: /[\w)\]] as (?:readonly |unknown\b|any\b|[A-Z[{(])|\bcast\(|:\s*any\b|<any>|\bAny\b|interface\{\}/,
    skip: /^\s*(import|export|from)\b|^\s*\w+ as \w+,?$/,
  },
  { name: "non-null `!`, `unwrap()`", pattern: /[\w)]!(?=[.),;])|\.unwrap\(\)/ },
  {
    name: "пустой или глотающий обработчик ошибки",
    pattern: /catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}|except(\s+\w+)?\s*:\s*pass\b|\.catch\(\(\)\s*=>\s*(\{\s*\}|undefined|null)\)/,
  },
  { name: "таймер или задержка", pattern: /\b(setTimeout|setInterval|requestIdleCallback|sleep|time\.sleep|delay)\(/ },
  {
    name: "отключённая проверка",
    pattern: /(eslint|oxlint|biome)-(disable|ignore)|@ts-(ignore|expect-error|nocheck)|#\s*type:\s*ignore|#\s*noqa|\/\/\s*nolint|#\[allow\(/,
    inComments: true,
  },
  {
    // `\b` в JS не видит границ кириллического слова: без `\p{L}` «Одновременно» и «временной» дали бы «временно».
    name: "метка «потом»",
    pattern: /\b(TODO|FIXME|HACK|XXX|workaround|for now|temporary)\b|(?<!\p{L})(на будущее|временно(?!\p{L})|пока что|костыл)/iu,
    inComments: true,
  },
];

const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
const { range, paths } = parseArgs(process.argv.slice(2));
// Сравнение с рабочим деревом (`HEAD`, `main`) не видит новых файлов вне git, поэтому их добавляем сами.
const withWorktree = !range.includes("--cached") && !range.some((arg) => arg.includes(".."));
const untracked = withWorktree ? untrackedFiles() : [];
const changed = changedFiles();

if (changed.length === 0) {
  console.log(`Нет изменений в диффе: git diff ${range.join(" ")}`);
  process.exit(0);
}

const code = changed.filter((file) => CODE_FILE.test(file.path));
const added = addedLines(code);

console.log(`Дифф: git diff ${range.join(" ")}${untracked.length > 0 ? ` и ${untracked.length} новых файлов вне git` : ""}`);
printModuleBalance(code);
printGrowingFiles(code);
printUnusedExports(added);
printCopies(changed);
printManifestChanges();
printRiskyAdditions(added);

function parseArgs(args) {
  const split = args.indexOf("--");
  const rangeArgs = split === -1 ? args : args.slice(0, split);
  const pathArgs = split === -1 ? [] : args.slice(split + 1);

  if (rangeArgs.length > 0) return { range: rangeArgs, paths: pathArgs };

  // После реализации staged обычно пуст: тогда ревью идёт по всему незакоммиченному.
  const staged = git(["diff", "--cached", "--name-only", "--", ...pathArgs]).trim();

  return { range: staged ? ["--cached"] : ["HEAD"], paths: pathArgs };
}

function diff(args) {
  return git(["diff", ...args, ...range, "--", ...paths]);
}

function untrackedFiles() {
  return git(["ls-files", "--others", "--exclude-standard", "--", ...paths])
    .split("\n")
    .filter((path) => path && !GENERATED.test(path) && existsSync(join(root, path)));
}

function changedFiles() {
  const status = statusByPath();
  const tracked = diff(["--numstat", "-M"])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [addedCount, removed, rawPath] = line.split("\t");
      const path = renamedTarget(rawPath);

      return {
        path,
        added: Number(addedCount) || 0,
        removed: Number(removed) || 0,
        status: status.get(path) ?? "M",
      };
    });
  const created = untracked.map((path) => ({ path, added: currentLines(path), removed: 0, status: "A" }));

  return [...tracked, ...created].filter((file) => !GENERATED.test(file.path));
}

// `--numstat -M` пишет переименование как `dir/{old => new}/file` или `old => new`.
function renamedTarget(path) {
  return path.replace(/\{[^{}]* => ([^{}]*)\}/, "$1").replace(/^.* => /, "").replace(/\/\//g, "/");
}

// Переименование получает статус `R`, а не нового файла: перенесённый без изменений код новым не считается.
function statusByPath() {
  return new Map(
    diff(["--name-status", "-M"])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const fields = line.split("\t");

        return [fields.at(-1), fields[0][0]];
      }),
  );
}

// Добавленные строки продуктового кода: из диффа и целиком из новых файлов вне git.
function addedLines(files) {
  const product = new Set(files.filter((file) => !TEST_FILE.test(file.path)).map((file) => file.path));
  const lines = [];
  let path = "";
  let line = 0;

  for (const text of diff(["-U0", "-M"]).split("\n")) {
    if (text.startsWith("+++ ")) {
      path = text.slice(6);
      continue;
    }

    const hunk = /^@@ -\S+ \+(\d+)/.exec(text);

    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }

    if (!text.startsWith("+") || !product.has(path)) continue;

    lines.push({ path, line, text: text.slice(1) });
    line += 1;
  }

  for (const path of untracked) {
    if (!product.has(path)) continue;

    readFileSync(join(root, path), "utf8")
      .split("\n")
      .forEach((text, index) => lines.push({ path, line: index + 1, text }));
  }

  return lines;
}

function moduleOf(path) {
  const parts = path.split("/");

  if (parts.length === 1) return "(корень)";
  if (WORKSPACE_DIRS.has(parts[0]) && parts.length > 2) return `${parts[0]}/${parts[1]}`;

  return parts[0];
}

// Баланс строк по модулям: где задача добавила код и где удалила.
function printModuleBalance(files) {
  const modules = new Map();

  for (const file of files) {
    const name = moduleOf(file.path);
    const entry = modules.get(name) ?? { added: 0, removed: 0, created: 0, deleted: 0 };

    entry.added += file.added;
    entry.removed += file.removed;
    entry.created += file.status === "A" ? 1 : 0;
    entry.deleted += file.status === "D" ? 1 : 0;
    modules.set(name, entry);
  }

  const rows = [...modules].sort((a, b) => net(b[1]) - net(a[1]));
  const total = rows.reduce((sum, [, entry]) => sum + net(entry), 0);

  section(`Баланс строк кода по модулям (итого ${signed(total)})`);

  if (rows.length === 0) console.log("  кода в диффе нет");

  for (const [name, entry] of rows) {
    const counts = entry.created + entry.deleted > 0 ? `  файлов +${entry.created} −${entry.deleted}` : "";

    console.log(`  ${signed(net(entry)).padStart(6)}  +${entry.added} −${entry.removed}  ${name}${counts}`);
  }
}

// Файлы, которые выросли сильно, большие файлы, которые продолжают расти, и точки сборки.
function printGrowingFiles(files) {
  const growing = files
    .filter((file) => file.status !== "D" && net(file) > 0)
    .map((file) => ({ ...file, lines: currentLines(file.path) }));
  const big = growing.filter((file) => file.status !== "A" && grewNoticeably(file));
  const created = growing.filter((file) => file.status === "A" && file.lines >= BIG_GROWTH_LINES);
  const hubs = growing.filter((file) => isHub(basename(file.path)) && !TEST_FILE.test(file.path));

  section("Рост файлов: не вторая ли это ответственность?");
  printFileRows(big, `выросли на ${BIG_GROWTH_LINES}+ строк, на четверть или уже больше ${LARGE_FILE_LINES} строк`);
  printFileRows(created, `новые от ${BIG_GROWTH_LINES} строк`);

  if (big.length + created.length === 0) console.log("  нет");

  section("Точки сборки, store, входы: растут только связыванием, а не логикой?");
  printFileRows(hubs, "выросли");

  if (hubs.length === 0) console.log("  не выросли");
}

function isHub(name) {
  return HUB_NAME.test(name) || HUB_PATTERN.test(name);
}

function grewNoticeably(file) {
  const before = file.lines - net(file);
  const relative = net(file) >= RELATIVE_GROWTH_LINES && net(file) >= before * RELATIVE_GROWTH;

  return net(file) >= BIG_GROWTH_LINES || file.lines >= LARGE_FILE_LINES || relative;
}

function printFileRows(rows, title) {
  if (rows.length === 0) return;

  console.log(`  ${title}:`);

  for (const file of rows.sort((a, b) => net(b) - net(a))) {
    const churn = `+${file.added} −${file.removed}`.padEnd(11);

    console.log(`    ${signed(net(file)).padStart(6)}  ${churn}  ${String(file.lines).padStart(5)} строк  ${file.path}`);
  }
}

// Новый экспорт без единого упоминания вне своего файла означает код без потребителя или лишний `export`.
function printUnusedExports(lines) {
  const exports = lines
    .filter((entry) => JS_FILE.test(entry.path))
    .map((entry) => ({ ...entry, name: JS_EXPORT.exec(entry.text)?.[1] }))
    .filter((entry) => entry.name)
    .slice(0, MAX_EXPORTS_CHECKED);
  const unused = exports.filter((entry) => usagesOutside(entry.name, entry.path) === 0);

  section("Новые экспорты без потребителя вне своего файла (JS/TS): снять export или удалить?");

  if (exports.length === 0) {
    console.log("  новых экспортов нет");
    return;
  }

  if (unused.length === 0) {
    console.log(`  нет (проверено ${exports.length})`);
    return;
  }

  for (const entry of unused) {
    console.log(`    ${entry.path}:${entry.line}  ${entry.name}`);
  }
}

function usagesOutside(name, path) {
  const found = tryGit(["grep", "-l", "-w", "--untracked", "-e", name, "--", ".", `:(exclude)${path}`]);

  return found.split("\n").filter((file) => file && !GENERATED.test(file)).length;
}

// Одинаковые новые файлы: копии данных, фикстур, конфигов и кода вместо общего источника.
function printCopies(files) {
  const blobs = newBlobs();
  const groups = new Map();

  for (const file of files.filter((entry) => entry.status === "A")) {
    const blob = blobs.get(file.path) ?? diskBlob(file.path);

    if (!blob || blob === EMPTY_BLOB) continue;

    groups.set(blob, [...(groups.get(blob) ?? []), file.path]);
  }

  const copies = [...groups.values()].filter((group) => group.length > 1);

  section("Одинаковые новые файлы: почему не один источник?");

  if (copies.length === 0) {
    console.log("  нет");
    return;
  }

  for (const group of copies) {
    console.log(`  ${group.length} одинаковых: ${group.slice(0, 3).join(", ")}${group.length > 3 ? ", …" : ""}`);
  }
}

// Хеш содержимого на конце диапазона; нули означают файл в рабочем дереве, его хеш считается с диска.
function newBlobs() {
  const blobs = new Map();

  for (const line of diff(["--raw", "--no-abbrev", "-M"]).split("\n")) {
    const match = /^:\S+ \S+ \S+ (\w{40}) A\t(.+)$/.exec(line);

    if (match && !/^0+$/.test(match[1])) blobs.set(match[2], match[1]);
  }

  return blobs;
}

// Тот же хеш, что у git (`git hash-object`), чтобы сравнивать файлы с диска и из диапазона.
function diskBlob(path) {
  const full = join(root, path);

  if (!existsSync(full)) return undefined;

  const content = readFileSync(full);

  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

// Изменённые строки манифестов: новые зависимости и входы пакетов требуют причины и правки карты проекта.
function printManifestChanges() {
  const lines = [];
  let path = "";

  for (const line of diff(["-U0", "-M"]).split("\n")) {
    if (line.startsWith("+++ ")) {
      path = line.slice(6);
      continue;
    }

    if (line.startsWith("---") || !/^[+-]\s*\S/.test(line) || !MANIFEST_FILE.test(path) || MANIFEST_VERSION.test(line)) {
      continue;
    }

    lines.push(`    ${path}: ${line.trim()}`);
  }

  section("Манифесты: новая зависимость или вход пакета обоснованы и отражены в карте проекта?");
  console.log(lines.length === 0 ? "  без изменений" : lines.slice(0, MAX_MANIFEST_LINES).join("\n"));
}

// Добавленные конструкции, которые чаще всего прячут неявный контракт, ветку без потребителя или костыль.
function printRiskyAdditions(lines) {
  const hits = RISKY_ADDITIONS.map((signal) =>
    lines.filter(
      (entry) =>
        (signal.inComments || !COMMENT_LINE.test(entry.text)) &&
        signal.pattern.test(entry.text) &&
        !signal.skip?.test(entry.text),
    ),
  );

  section(
    "Добавленные конструкции: кто сегодня передаёт пусто (никто: сделать обязательным), какой контракт не выражен типом, что за костылём?",
  );

  if (hits.every((found) => found.length === 0)) {
    console.log("  нет");
    return;
  }

  RISKY_ADDITIONS.forEach((signal, index) => {
    const found = hits[index];

    if (found.length === 0) return;

    const shown = found.length > EXAMPLES_PER_SIGNAL ? ` (первые ${EXAMPLES_PER_SIGNAL})` : "";

    console.log(`  ${signal.name}: ${found.length}${shown}`);

    for (const entry of found.slice(0, EXAMPLES_PER_SIGNAL)) {
      console.log(`    ${`${entry.path}:${entry.line}  ${entry.text.trim()}`.slice(0, 150)}`);
    }
  });
}

function currentLines(path) {
  const file = join(root, path);

  return existsSync(file) ? readFileSync(file, "utf8").split("\n").length - 1 : 0;
}

function net(entry) {
  return entry.added - entry.removed;
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

function section(title) {
  console.log(`\n## ${title}`);
}

function git(args, cwd = root) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// `git grep` без совпадений завершается кодом 1: это пустой результат, а не ошибка.
function tryGit(args) {
  try {
    return git(args);
  } catch (error) {
    if (error.status === 1) return "";

    throw error;
  }
}
