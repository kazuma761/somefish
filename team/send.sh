#!/usr/bin/env bash
# Team chat. Every message lands in team/CHAT.md, shown live in the chat pane.
# usage: team/send.sh <to> <from> <message...>
#   to = chat                         post a status line only (everyone can read it)
#        all                          also type it into every other agent's prompt
#        lead|agent|data|ui|reviewer  direct message, typed into that agent's prompt
set -euo pipefail
to=$1 from=$2
shift 2
msg="$*"
printf '%s  %-8s -> %-8s %s\n' "$(date +%H:%M:%S)" "$from" "$to" "$msg" >> "$(dirname "$0")/CHAT.md"
[ "$to" = chat ] && exit 0

sent=0
while read -r pane agent; do
  [ -n "$agent" ] && [ "$agent" != chat ] && [ "$agent" != "$from" ] || continue
  [ "$to" = all ] || [ "$to" = "$agent" ] || continue
  tmux -L ai-teammates send-keys -t "$pane" -l "[$from -> $to] $msg"
  sleep 0.5
  tmux -L ai-teammates send-keys -t "$pane" Enter
  sent=1
done < <(tmux -L ai-teammates list-panes -s -t ai-teammates-team -F '#{pane_id} #{@agent}')
[ "$sent" = 1 ] || { echo "no agent pane named '$to' (use chat, all, lead, agent, data, ui or reviewer)" >&2; exit 1; }
