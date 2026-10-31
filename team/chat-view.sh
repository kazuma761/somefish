#!/usr/bin/env bash
# Live team chat for the bottom pane: each sender's lines in that agent's pane color.
cd "$(dirname "$0")"
tail -n 50 -f CHAT.md | awk '
BEGIN {
  c["lead"]     = "1;38;2;95;175;255"    # blue
  c["agent"]    = "1;38;2;255;107;107"   # red
  c["data"]     = "1;38;2;95;215;135"    # green
  c["ui"]       = "1;38;2;215;135;255"   # purple
  c["reviewer"] = "1;38;2;255;175;95"    # orange
  c["team"]     = "1;38;2;255;215;95"    # yellow (the launcher and you)
  c["you"]      = "1;38;2;255;215;95"
}
{ printf "\033[%sm%s\033[0m\n", ($2 in c ? c[$2] : "0"), $0; fflush() }'
