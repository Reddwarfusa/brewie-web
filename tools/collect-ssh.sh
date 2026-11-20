#!/bin/bash
# Read-only look inside the Brewie over SSH. Run from the brewie-web folder:
#   bash tools/collect-ssh.sh 192.168.10.60
# Asks for the root password once (ReBrewie documents the default as "terminat").
# It only lists and copies files; nothing on the machine is changed.
set -u
HOST="${1:?usage: bash tools/collect-ssh.sh <brewie-ip>}"
OUT="capture/ssh"; mkdir -p "$OUT"
CTL="/tmp/brewie-ssh-$$"
OPTS=(-o StrictHostKeyChecking=accept-new -o ControlMaster=auto -o ControlPath="$CTL" -o ControlPersist=120
      -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa
      -o KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group1-sha1)
run() { ssh "${OPTS[@]}" "root@$HOST" "$@"; }

echo "Connecting to root@$HOST (enter the Brewie's root password if asked)…"
if ! run 'echo connected' ; then
  echo "SSH with legacy options failed; retrying with defaults…"
  OPTS=(-o StrictHostKeyChecking=accept-new -o ControlMaster=auto -o ControlPath="$CTL" -o ControlPersist=120)
  run 'echo connected' || { echo "✗ Could not log in over SSH."; exit 1; }
fi

echo "Collecting system info…"
run 'sh -s' > "$OUT/info.txt" 2>&1 <<'REMOTE'
echo "== uname"; uname -a
echo "== os"; cat /etc/os-release /etc/issue 2>/dev/null
echo "== uptime/df"; uptime; df -h
echo "== processes"; ps w 2>/dev/null || ps aux
echo "== listening"; (netstat -tlnp || netstat -tln || ss -tlnp) 2>/dev/null
echo "== brewie files"; find / -xdev \( -iname '*brewie*' -o -name '*.brewie' -o -iname '*recipe*' \) 2>/dev/null | grep -v '^/proc' | head -500
echo "== app binary"; for p in $(pgrep -f BrewieApplication 2>/dev/null); do ls -l /proc/$p/exe /proc/$p/cwd; cat /proc/$p/cmdline | tr '\0' ' '; echo; done
which BrewieApplication brewie-upload-fw 2>/dev/null
echo "== init"; ls -la /etc/init.d /etc/rc*.d 2>/dev/null | head -80
REMOTE

echo "Copying recipes, settings and the BrewieApplication binary…"
run 'sh -s' > "$OUT/brewie-files.tgz" 2>"$OUT/tar-errors.txt" <<'REMOTE'
BIN=$(for p in $(pgrep -f BrewieApplication 2>/dev/null); do readlink /proc/$p/exe; done | head -1)
[ -z "$BIN" ] && BIN=$(which BrewieApplication 2>/dev/null)
FILES=$(find / -xdev \( -name '*.brewie' -o -name 'settings.json' -o -name 'sync.json' -o -iname '*brewie*.conf' -o -iname '*brewie*.ini' \) 2>/dev/null | grep -v '^/proc' | head -400)
tar czf - $BIN $FILES 2>/dev/null
REMOTE

ssh "${OPTS[@]}" -O exit "root@$HOST" 2>/dev/null
ls -la "$OUT"
echo "Done. Results are in $OUT"
