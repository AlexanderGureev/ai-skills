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
    tr -d '\r' < AGENTS.md | grep -qxF "$heading" || printf '  %s\n' "$heading"
  done)

  if [ -n "$missing" ]; then
    printf 'AGENTS.md есть, не тронут. Нет разделов шаблона (могут называться иначе):\n%s\n' "$missing"
  else
    echo "AGENTS.md есть, не тронут: разделы шаблона на месте."
  fi

  if ! grep -q 'review/principles\.md' AGENTS.md; then
    echo "В AGENTS.md нет ссылки на review/principles.md: добавьте её по шаблону, если нужны общие принципы и вне навыков."
  fi
else
  cp "$template" AGENTS.md
  echo "AGENTS.md создан из шаблона: заполните разделы."
fi

had_other_specs=""
if [ -d spec ]; then
  for entry in spec/*; do
    [ -e "$entry" ] || continue
    case "$entry" in
      spec/actual|spec/archive) ;;
      *) had_other_specs=1; break ;;
    esac
  done
fi

for dir in spec/actual spec/archive docs; do
  if [ -d "$dir" ]; then
    echo "$dir есть."
  else
    mkdir -p "$dir"
    touch "$dir/.gitkeep"
    echo "$dir создан."
  fi
done

if [ -n "$had_other_specs" ]; then
  echo "В spec/ уже есть другие файлы или папки: они не тронуты; навыки ведут задачи в spec/actual/ и spec/archive/."
fi

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git check-ignore -q spec/actual/001.md 2>/dev/null || git check-ignore -q spec/archive/001.md 2>/dev/null; then
    echo "Внимание: spec/actual/ или spec/archive/ игнорируется в .gitignore; навык impl опирается на хранение спек в git."
  fi
fi
