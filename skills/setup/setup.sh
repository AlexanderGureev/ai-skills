#!/bin/sh
# Заготовка проекта под навыки spec, impl и review. Существующие файлы не перезаписывает.
set -eu

skill_dir=$(cd "$(dirname "$0")" && pwd)
template="$skill_dir/AGENTS.template.md"
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

cd "$root"
echo "Проект: $root"

if [ -e AGENTS.md ]; then
  missing=$(grep '^## ' "$template" | while IFS= read -r heading; do
    grep -qxF "$heading" AGENTS.md || printf '  %s\n' "$heading"
  done)

  if [ -n "$missing" ]; then
    printf 'AGENTS.md есть, не тронут. Нет разделов шаблона (могут называться иначе):\n%s\n' "$missing"
  else
    echo "AGENTS.md есть, не тронут: разделы шаблона на месте."
  fi
else
  cp "$template" AGENTS.md
  echo "AGENTS.md создан из шаблона: заполните разделы."
fi

for dir in spec/actual spec/archive; do
  if [ -d "$dir" ]; then
    echo "$dir есть."
  else
    mkdir -p "$dir"
    touch "$dir/.gitkeep"
    echo "$dir создан."
  fi
done

# Claude Code читает AGENTS.md сам, только пока в проекте нет CLAUDE.md. CLAUDE.md с импортом держит AGENTS.md в
# контексте и после того, как CLAUDE.md появится (например, от встроенного /init).
if [ ! -e CLAUDE.md ] && [ ! -e .claude/CLAUDE.md ]; then
  echo "@AGENTS.md" > CLAUDE.md
  echo "CLAUDE.md создан: импортирует AGENTS.md."
fi

for claude in CLAUDE.md .claude/CLAUDE.md; do
  if [ -e "$claude" ] && ! grep -q '@AGENTS.md' "$claude"; then
    echo "В $claude нет строки @AGENTS.md: без неё Claude Code не читает AGENTS.md — добавьте её первой строкой."
  fi
done
