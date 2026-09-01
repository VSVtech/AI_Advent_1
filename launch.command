#!/bin/zsh

set -u

project_dir="${0:A:h}"

print -P '%F{green}Запускаю DeepSeek Chat…%f'

/bin/zsh -lic 'cd -- "$1" && exec ./start.sh' _ "$project_dir"
status=$?

if (( status != 0 && status != 130 )); then
  print -u2 ''
  print -u2 'Не удалось запустить сервер. Сообщение об ошибке находится выше.'
  read -r '?Нажмите Enter, чтобы закрыть окно…'
fi

exit "$status"
