#!/usr/bin/env bash
# Start the 5-agent team side by side: one tmux window, 5 color-coded agent columns (plain
# `claude`, auto mode) plus a full-width color-coded team-chat strip at the bottom.
# Watch it with: tmux -L ai-teammates attach -t ai-teammates-team
# Stop it with:  tmux -L ai-teammates kill-server
set -euo pipefail
cd "$(dirname "$0")/.."
# Its own tmux server: macOS can deny an already-running server access to ~/Downloads,
# and then nothing in its panes can read this project.
tmux() { command tmux -L ai-teammates "$@"; }
S=ai-teammates-team
AGENTS=(lead agent data ui reviewer)
ROLES=("Tech Lead / Integrator" "AI Engineer / Chat Agent + Tools" "Backend Engineer / Data + Billing" "Frontend Engineer / App + Chat UI" "Staff Engineer / QA + Review")
BGS=("#0b1d33" "#33100f" "#0f2b17" "#2a1238" "#332a0b")      # navy, maroon, forest, plum, amber
COLORS=("#5fafff" "#ff6b6b" "#5fd787" "#d787ff" "#ffaf5f")   # same hues as team/chat-view.sh
if tmux has-session -t "$S" 2>/dev/null; then
  echo "session $S already exists: tmux -L ai-teammates attach -t $S"
  exit 1
fi
touch team/CHAT.md

tmux new-session -d -s "$S" -n team -c "$PWD" -x 240 -y 64
for _ in 1 2 3 4; do
  tmux split-window -h -t "$S:team" -c "$PWD"
  tmux select-layout -t "$S:team" even-horizontal  # vertical columns, side by side
done
panes=($(tmux list-panes -t "$S:team" -F '#{pane_id}'))
style() {  # pane agent role bg color
  tmux set-option -p -t "$1" @agent "$2"
  tmux set-option -p -t "$1" @role "$3"
  tmux set-option -p -t "$1" window-style "bg=$4"
  tmux set-option -p -t "$1" window-active-style "bg=$4"
  tmux set-option -p -t "$1" @color "$5"
}
for i in "${!AGENTS[@]}"; do
  style "${panes[$i]}" "${AGENTS[$i]}" "${ROLES[$i]}" "${BGS[$i]}" "${COLORS[$i]}"
done
chat=$(tmux split-window -t "$S:team" -f -v -l 12 -c "$PWD" -P -F '#{pane_id}' "team/chat-view.sh")
style "$chat" chat "team chat (team/CHAT.md)" "#1c1c1c" "#ffd75f"
tmux set-option -w -t "$S:team" pane-border-status top
tmux set-option -w -t "$S:team" pane-border-format ' #[fg=#{@color},bold]#{@agent}#[default] | #[fg=#{@color}]#{@role}#[default] '
tmux set-option -w -t "$S:team" pane-border-style 'fg=#444444'
tmux set-option -w -t "$S:team" automatic-rename off

printf '%s  %-8s -> %-8s %s\n' "$(date +%H:%M:%S)" team all \
  "Team up: lead, agent, data, ui, reviewer. Spec: team/CONTRACT.md" >> team/CHAT.md
# BUN_OPTIONS stops claude auto-loading the project's env file, which keeps the app's
# secrets out of the agents' environment.
for i in "${!AGENTS[@]}"; do
  a=${AGENTS[$i]}
  tmux send-keys -t "${panes[$i]}" \
    "BUN_OPTIONS=--no-env-file claude --permission-mode auto --settings team/agent-settings.json \"You are '$a', the team's ${ROLES[$i]}. Read team/briefs/$a.md and team/CONTRACT.md and follow them. Your teammates are running beside you; use the team chat.\"" Enter
done
tmux select-pane -t "${panes[0]}"
echo "started: tmux -L ai-teammates attach -t $S"
