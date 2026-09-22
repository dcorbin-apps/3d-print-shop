#!/bin/bash
set -euo pipefail

# AIDEV-NOTE: this exists because the shop refuses to make its own data directory, and that refusal is
# deliberate - a service that creates whatever path it was pointed at puts a queue somewhere nobody
# is looking, and a typo is then work lost rather than a shop that will not start. See
# design/3d-print-shop.md, "The installer creates the root; the service never does". So the two
# directories, the user that owns them, and the supervisor that starts the process are this file's.
#
# Nothing here writes a credential. `init` does that, as the service user, and it is the one step
# that has to be a person's - the token it answers with exists nowhere else.

LABEL=com.dcorbin.3d-print-shop
# AIDEV-NOTE: three places rather than one, because the three things a shop keeps are three kinds and
# the system says where each goes: work awaiting processing, state that outlives a restart, and a
# claim that must not. The service works these out itself from `systemLayout` - what the installer
# does is MAKE the two that have to be there before it starts. The third is /var/run, which is
# emptied by a boot and so is the shop's own to create every time.
JOBS=/var/spool/3d-print-shop/jobs
STATE=/var/lib/3d-print-shop
ETC=/etc/3d-print-shop
OUT_LOG=/var/log/3d-print-shop.log
ERR_LOG=/var/log/3d-print-shop.err.log

# AIDEV-NOTE: the shop is COPIED here rather than run out of a checkout, because the service user is
# not the developer and a home directory is not theirs to walk into - `/Users/<somebody>` is 0750 on
# macOS, so a daemon pointed at a checkout inside one cannot read a byte of it. Copying also means a
# `git checkout` of another branch is not a live change to the running service.
INSTALL_DIR=/usr/local/lib/3d-print-shop

# AIDEV-NOTE: followed through every LINK to the file itself, because npm installs a bin as a
# symlink - /usr/bin/3d-print-shop-install -> ../lib/node_modules/@3d-print-shop/server/install.sh -
# and `cd "$(dirname ...)" && pwd` gives the directory of the link, not of the script. That read
# /usr/bin as a checkout rooted at /, and refused the first install anybody ran by typing the name.
# A loop over `readlink` rather than `readlink -f`, which older macOS does not have.
whereThisReallyIs() {
  local source=${BASH_SOURCE[0]} directory

  while [ -L "$source" ]; do
    directory=$(cd "$(dirname "$source")" && pwd)
    source=$(readlink "$source")
    case "$source" in /*) ;; *) source="$directory/$source" ;; esac
  done

  cd "$(dirname "$source")" && pwd
}

HERE=$(whereThisReallyIs)

# AIDEV-NOTE: two ways this file is reached, and the difference is who put the code somewhere the
# service can read. Exploded by npm it sits INSIDE the server package, whose own dist is the thing
# to run and whose node_modules npm has already resolved - so there is nothing to copy and copying
# would be a second, staler tree. In a checkout there is a build, sitting where a daemon cannot get
# at it.
case "$HERE" in
  */node_modules/@3d-print-shop/server) MODE=package ;;
  *) MODE=checkout ;;
esac

# AIDEV-NOTE: npm does NOT hoist a global install's dependencies up into the scope directory - it
# nests them under the installed package's own node_modules, so the page is at
# `server/node_modules/@3d-print-shop/ui` and NOT at `server/../ui`. A local install hoists and gives
# the second shape, so both are real layouts and both are looked for. Measured against npm on Linux,
# after a global install refused itself by looking only where nothing was.
packagedAt() {
  local relative=$1 candidate

  for candidate in "$HERE/node_modules/@3d-print-shop/$relative" "$HERE/../$relative"; do
    if [ -e "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done

  # Neither. The nested one is named, because it is where npm would have put it had it put it anywhere.
  echo "$HERE/node_modules/@3d-print-shop/$relative"
}

if [ "$MODE" = package ]; then
  # AIDEV-NOTE: the server is not looked for, because this file ships INSIDE it - `$HERE` is the
  # package, and its `dist` is the only build that can be the right one. Only the page is hunted,
  # because that is a separate package and npm may have put it in either of two places.
  BUILT="$HERE/dist/main.js"
  SERVER=$BUILT
  MANIFEST="$HERE/package.json"
  BUILT_PAGE=$(packagedAt ui/dist)
  PAGE=$BUILT_PAGE
else
  REPO=$(cd "$HERE/../.." && pwd)
  BUILT="$REPO/packages/server/dist/main.js"
  SERVER="$INSTALL_DIR/packages/server/dist/main.js"
  MANIFEST="$REPO/package.json"
  BUILT_PAGE="$REPO/packages/ui/dist"
  PAGE="$INSTALL_DIR/packages/ui/dist"
fi

# AIDEV-NOTE: always said, because the page is not optional - `requirePage` has already refused an
# install without one. It used to be left out when the directory was missing, which is how a shop
# that served nobody anything came up looking like a successful install.
pageArguments() {
  printf '    <string>--page</string>\n    <string>%s</string>\n' "$PAGE"
}

pageOption() {
  printf ' --page %s' "$PAGE"
}

PLIST="/Library/LaunchDaemons/$LABEL.plist"
UNIT=/etc/systemd/system/3d-print-shop.service

# The shop's own default port. Said here only so the closing message can say where it answers.
PORT=7373

# AIDEV-NOTE: empty unless somebody said, which leaves the shop on its own default - loopback, because a
# token or a password sent to it travels in the clear. Said with `--listen`, it goes into the service
# as `serve --listen`, and it is KEPT by a later install that does not say it again: re-running this
# is meant to be safe, and quietly putting a shop the workshop reaches back onto loopback is not.
LISTEN=''

listenArguments() {
  [ -n "$LISTEN" ] || return 0
  printf '    <string>--listen</string>\n    <string>%s</string>\n' "$LISTEN"
}

listenOption() {
  [ -n "$LISTEN" ] || return 0
  printf ' --listen %s' "$LISTEN"
}

# What the service already installed was told to listen on, from whichever file this platform writes.
listenedOnBefore() {
  if [ "$PLATFORM" = macos ]; then
    [ -f "$PLIST" ] || return 0
    awk '/<string>--listen<\/string>/ { getline; gsub(/.*<string>|<\/string>.*/, ""); print; exit }' "$PLIST"
  else
    [ -f "$UNIT" ] || return 0
    sed -n 's/^ExecStart=.* --listen \([^ ]*\).*/\1/p' "$UNIT" | head -1
  fi
}

# Where a person reaches it, and - when that is past loopback - what that costs, said while it can
# still be undone.
whereItAnswers() {
  case "${LISTEN:-127.0.0.1}" in
    127.0.0.1 | localhost | ::1)
      printf 'on http://localhost:%s - loopback, which is where a token travelling in the clear belongs.' "$PORT"
      ;;
    *)
      local host=$LISTEN
      case "$host" in 0.0.0.0 | ::) host=$(hostname) ;; esac
      printf 'on http://%s:%s - on the network, over plain HTTP. A password typed into the page and a\n' "$host" "$PORT"
      printf "client's token can be read by anybody on that network who is looking."
      ;;
  esac
}

case "$(uname -s)" in
  Darwin) PLATFORM=macos; SHOP_USER=_printshop; ROOT_GROUP=wheel ;;
  Linux) PLATFORM=linux; SHOP_USER=printshop; ROOT_GROUP=root ;;
  *) echo "3d-print-shop installs on macOS and Linux, not $(uname -s)" >&2; exit 1 ;;
esac
SHOP_GROUP=$SHOP_USER

say() { printf '%s\n' "$*"; }
refuse() { printf '%s\n' "$*" >&2; exit 1; }

usage() {
  cat <<USAGE
usage: sudo $0 [install|update|uninstall] [--listen <address>]

install    make the data and credentials directories, the user that owns them, the copy of the
           shop the service runs, and the service itself
update     copy a fresh build over the installed one and restart - what to run after 'yarn build',
           and only from a checkout: an installed package is updated by installing it again
uninstall  stop the service and remove it - the data, the credentials and the user are left,
           because they hold work and secrets this script did not create

--listen   the address the shop answers on - 0.0.0.0 for every one this machine has. Loopback
           unless said, and an install that does not say keeps what the last one said
USAGE
}

# Named as the person would type it, which is the bin npm put on their PATH once there is one.
asTyped() {
  if [ "$MODE" = package ]; then printf '3d-print-shop-install %s' "$1"; else printf '%s %s' "$0" "$1"; fi
}

requireRoot() {
  [ "$(id -u)" = 0 ] || refuse "this writes under /var, /etc and /usr/local, so it needs sudo: sudo $(asTyped "$1")"
}

# AIDEV-NOTE: the page is REQUIRED, and this is where that is enforced. The shop is installed for a
# person to use and the page is how a person uses it - it is where somebody logs in, watches a
# machine and gives a verdict on what came off the bed. A shop answering only its API is a shop
# nobody in the workshop can do any of that with, so it is refused rather than installed and
# mentioned. Shaped like `requireBuild` below, and for the same reason: each mode is told the remedy
# it actually has.
requirePage() {
  [ -d "$BUILT_PAGE" ] && return 0

  # AIDEV-NOTE: the page is its own package and the server does NOT depend on it - the page is a
  # client of the shop, and the dependency runs one way. So it is installed beside the server by
  # name, and at the server's own version: the two are released together, and a page from another
  # release is one the page itself will complain about.
  if [ "$MODE" = package ]; then
    refuse "$BUILT_PAGE is not there - the page is a package of its own, installed beside this one:
sudo npm i -g @3d-print-shop/ui@$(packageVersion)"
  fi

  refuse "$BUILT_PAGE is not there - run 'yarn install && yarn build' in $REPO first, which builds it"
}

requireBuild() {
  if [ ! -f "$BUILT" ]; then
    if [ "$MODE" = package ]; then
      refuse "$BUILT is not there - this package was installed without its build. Install it again:
sudo npm i -g @3d-print-shop/server@$(packageVersion)"
    fi

    refuse "$BUILT is not there - run 'yarn install && yarn build' in $REPO first"
  fi

  # AIDEV-NOTE: the same rule the node has to pass, and for the same reason - an npm run under a
  # version manager explodes its global packages inside the home directory, which is the one place
  # the service user cannot walk into. Checked here rather than left to fail at boot with a daemon
  # that starts, finds nothing, and is restarted for ever.
  if [ "$MODE" = package ]; then
    case "$HERE" in
      /Users/* | /home/* | "$HOME"/*)
        refuse "this is installed under $HERE, and the service runs as $SHOP_USER, which cannot read
into a home directory. Install it with a node that lives outside one (brew install node@24, or your
distribution's package), so that npm puts its global packages outside one too"
        ;;
    esac
  fi
}

# The release in play, from the same manifest the node floor is read out of.
packageVersion() {
  sed -n 's/^ *"version" *: *"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1
}

# The floor whichever manifest is in play already declares, so this script says it nowhere: the
# repo's when run from a checkout, the installed package's own when npm exploded one. The ceiling in
# `engines` is the package manager's business; what matters here is not running the service on
# something older than the code was written for.
requiredNode() {
  local floor
  floor=$(sed -n 's/.*"node" *: *">=\([0-9][0-9.]*\).*/\1/p' "$MANIFEST" | head -1)

  # Said rather than shrugged at: a floor that came back empty would let every node past the check,
  # which is the version guard silently not being one.
  [ -n "$floor" ] || refuse "$MANIFEST does not say which node this runs on, as engines.node"

  printf '%s\n' "$floor"
}

isAtLeast() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]
}

# AIDEV-NOTE: a node under somebody's home directory is the one that cannot work here, and it is
# also the one a developer has - a version manager installs per user, and the daemon runs as
# somebody else. Found rather than assumed, and refused with the fix rather than installed into a
# service that would never start.
findNode() {
  local wanted=$1 candidate version found=''
  local major=${wanted%%.*}

  for candidate in \
    ${PRINT_SHOP_NODE:-} \
    "/opt/homebrew/opt/node@$major/bin/node" \
    /opt/homebrew/bin/node \
    "/usr/local/opt/node@$major/bin/node" \
    /usr/local/bin/node \
    /usr/bin/node \
    "$(command -v node || true)"; do
    if [ -z "$candidate" ] || [ ! -x "$candidate" ]; then continue; fi
    case "$candidate" in /Users/* | /home/* | "$HOME"/*) continue ;; esac

    version=$("$candidate" -v 2>/dev/null | tr -d v)
    if isAtLeast "$version" "$wanted"; then
      printf '%s\n' "$candidate"
      return 0
    fi

    found="$found
  $candidate (v$version)"
  done

  refuse "no node of $wanted or newer outside a home directory.${found:+ What is here:$found}

The shop runs as $SHOP_USER, which cannot read a node a version manager installed under yours.
Install one system-wide (brew install node@$major, or your distribution's package), or say
PRINT_SHOP_NODE=/path/to/node"
}

madeDirectory() {
  local directory=$1

  mkdir -p "$directory"
  chown "$SHOP_USER:$SHOP_GROUP" "$directory"

  # 0700 and nothing looser: a job directory another user could rename away is a print that silently
  # never happens, and the keys under /etc open the printers directly.
  chmod 700 "$directory"
  say "  $directory  ($SHOP_USER, 0700)"
}

# What the service reads, so it is root's and readable by everybody - the opposite of the two
# directories above, and for the opposite reason: there is nothing secret in it, and the one thing
# that must not happen is the user the service runs as being able to rewrite its own code.
copiedIn() {
  local what=$1 into="$INSTALL_DIR/$2"

  mkdir -p "$into"
  rm -rf "${into:?}/$(basename "$what")"
  cp -R "$what" "$into/"
}

copiedTheBuild() {
  local package

  copiedIn "$REPO/package.json" ''
  for package in client server; do
    copiedIn "$REPO/packages/$package/package.json" "packages/$package"
    copiedIn "$REPO/packages/$package/dist" "packages/$package"
  done

  # The page. Files rather than a module: the shop is pointed at the directory and told nothing about
  # what is in it. Not conditional - `requirePage` has already refused an install without one.
  copiedIn "$BUILT_PAGE" 'packages/ui'
}

# AIDEV-NOTE: node_modules whole, symlinks and all. Yarn links a workspace as a RELATIVE symlink
# (`@3d-print-shop/client -> ../../packages/client`), so a copy that keeps the layout keeps the
# links working, and `cp -R` copies a symlink as a symlink rather than following it.
copiedEverything() {
  copiedTheBuild
  copiedIn "$REPO/node_modules" ''
  droppedTheLinksThatLeadNowhere

  chown -R "root:$ROOT_GROUP" "$INSTALL_DIR"
  chmod -R a+rX,go-w "$INSTALL_DIR"
}

# AIDEV-NOTE: only the packages the service RUNS are copied, so a workspace link to one left behind -
# the octoprint-sim the tests print against - arrives pointing at nothing. Nothing resolves it at
# runtime, and it is removed anyway: a link that leads nowhere is not part of an install, and the
# next person to look in here should not have to work out whether it matters.
#
# Just this directory, because a workspace is the only thing yarn links rather than copies.
droppedTheLinksThatLeadNowhere() {
  local link

  for link in "$INSTALL_DIR/node_modules/@3d-print-shop"/*; do
    if [ -L "$link" ] && [ ! -e "$link" ]; then rm -f "$link"; fi
  done
}

# ---------------------------------------------------------------------------- macOS

freeSystemId() {
  local used candidate
  used=$( (dscl . -list /Users UniqueID; dscl . -list /Groups PrimaryGroupID) | awk '{print $2}')

  # 200-400 is where macOS keeps its own daemon users, and a uid below 500 is hidden from the login
  # window without anything else having to say so.
  for candidate in $(seq 200 400); do
    grep -qx "$candidate" <<<"$used" || { printf '%s\n' "$candidate"; return 0; }
  done

  refuse 'every system id between 200 and 400 is taken'
}

madeServiceUserOnMacos() {
  if dscl . -read "/Users/$SHOP_USER" >/dev/null 2>&1; then
    say "  $SHOP_USER is already here"
    return 0
  fi

  local id
  id=$(freeSystemId)

  dscl . -create "/Groups/$SHOP_GROUP"
  dscl . -create "/Groups/$SHOP_GROUP" PrimaryGroupID "$id"
  dscl . -create "/Groups/$SHOP_GROUP" RealName '3D Print Shop'
  dscl . -create "/Groups/$SHOP_GROUP" Password '*'

  dscl . -create "/Users/$SHOP_USER"
  dscl . -create "/Users/$SHOP_USER" UniqueID "$id"
  dscl . -create "/Users/$SHOP_USER" PrimaryGroupID "$id"
  dscl . -create "/Users/$SHOP_USER" RealName '3D Print Shop'
  dscl . -create "/Users/$SHOP_USER" NFSHomeDirectory /var/empty
  dscl . -create "/Users/$SHOP_USER" UserShell /usr/bin/false
  dscl . -create "/Users/$SHOP_USER" IsHidden 1
  dscl . -create "/Users/$SHOP_USER" Password '*'

  say "  $SHOP_USER (uid $id), which owns the data directory and can be logged in as by nobody"
}

wroteLog() {
  local file=$1

  touch "$file"
  chown "$SHOP_USER:$SHOP_GROUP" "$file"
  chmod 640 "$file"
}

wrotePlist() {
  local node=$1

  # AIDEV-NOTE: KeepAlive only where it did NOT exit cleanly. `3d-print-shop shutdown` is an
  # operator asking it to stop, and a plain KeepAlive would start it again a second later - which is
  # a shop that cannot be stopped without unloading the daemon.
  cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node</string>
    <string>$SERVER</string>
    <string>serve</string>
$(pageArguments)$(listenArguments)  </array>
  <key>UserName</key><string>$SHOP_USER</string>
  <key>GroupName</key><string>$SHOP_GROUP</string>
  <key>WorkingDirectory</key><string>$STATE</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>$OUT_LOG</string>
  <key>StandardErrorPath</key><string>$ERR_LOG</string>
</dict>
</plist>
PLIST

  # launchd refuses a plist anybody but root can write to.
  chown "root:$ROOT_GROUP" "$PLIST"
  chmod 644 "$PLIST"
  say "  $PLIST"
}

# ---------------------------------------------------------------------------- Linux

madeServiceUserOnLinux() {
  if getent passwd "$SHOP_USER" >/dev/null; then
    say "  $SHOP_USER is already here"
    return 0
  fi

  useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin "$SHOP_USER"
  say "  $SHOP_USER, which owns the data directory and can be logged in as by nobody"
}

wroteUnit() {
  local node=$1

  # AIDEV-NOTE: RuntimeDirectory because the shop claims /var/run/3d-print-shop at every start, as the
  # service user, and /run is root's - so it could never make it, and the first real install on Linux
  # would have failed there. systemd makes it owned by User= before each start and removes it at
  # stop, which is exactly the "meant to be emptied" the claim relies on.
  #
  # Restart=on-failure rather than always, for the reason the plist keeps KeepAlive conditional:
  # `3d-print-shop shutdown` is somebody asking it to stop. stdout is the shop's log and journald is
  # what captures it, so there is no file here to rotate.
  cat >"$UNIT" <<UNIT
[Unit]
Description=3D Print Shop
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$node $SERVER serve$(pageOption)$(listenOption)
ExecReload=/bin/kill -HUP \$MAINPID
User=$SHOP_USER
Group=$SHOP_GROUP
WorkingDirectory=$STATE
RuntimeDirectory=3d-print-shop
RuntimeDirectoryMode=0700
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

  chmod 644 "$UNIT"
  say "  $UNIT"
}

# ---------------------------------------------------------------------------- starting and stopping

startIt() {
  if [ "$PLATFORM" = macos ]; then
    launchctl bootout "system/$LABEL" 2>/dev/null || true
    launchctl enable "system/$LABEL"
    launchctl bootstrap system "$PLIST"
  else
    systemctl daemon-reload
    systemctl enable --now 3d-print-shop
  fi
}

stopIt() {
  if [ "$PLATFORM" = macos ]; then
    launchctl bootout "system/$LABEL" 2>/dev/null || true
  else
    systemctl stop 3d-print-shop 2>/dev/null || true
  fi
}

isInstalled() {
  if [ "$PLATFORM" = macos ]; then [ -f "$PLIST" ]; else [ -f "$UNIT" ]; fi
}

restarting() {
  if [ "$PLATFORM" = macos ]; then
    printf 'sudo launchctl kickstart -k system/%s' "$LABEL"
  else
    printf 'sudo systemctl restart 3d-print-shop'
  fi
}

reloading() {
  if [ "$PLATFORM" = macos ]; then
    printf 'sudo launchctl kill HUP system/%s' "$LABEL"
  else
    printf 'sudo systemctl reload 3d-print-shop'
  fi
}

reading() {
  if [ "$PLATFORM" = macos ]; then
    printf 'tail -f %s' "$OUT_LOG"
  else
    printf 'journalctl -u 3d-print-shop -f'
  fi
}

# ---------------------------------------------------------------------------- its first admin

# AIDEV-NOTE: a function rather than `[ -t 0 ]` written where it is asked, because it is the seam
# the tests read the other branch through - the one where nobody is at a keyboard, which no suite
# could otherwise reach. This used to have to fight npm for the terminal, because the install ran
# from a postinstall hook where npm held stdin and swallowed stdout. It does not any more: this is a
# command somebody types, so the terminal is simply theirs. See PLAN.md for why that moved.
atATerminal() { [ -t 0 ]; }

# AIDEV-NOTE: run as the SERVICE user, because $ETC is 0700 and theirs - a credentials file written
# by root is one the shop cannot read. `init` asks for the password itself and says the token once,
# so neither ever passes through this script, which is what keeps the rule at the top of this file
# true: nothing here writes a credential.
FIRST_ADMIN_ATTEMPTS=3

madeTheFirstAdmin() {
  local node=$1 name='' fallback=${SUDO_USER:-admin} attempt

  read -r -p "what to call the first admin, and own every job of theirs [$fallback]: " name || true

  # AIDEV-NOTE: asked AGAIN rather than given up on, because what `init` refuses is what was typed -
  # two passwords that differ, or one under its length - and it has said which, one line up. Giving
  # up printed a page of manual steps that buried that line, for a mistake a second try fixes.
  # Bounded, because ctrl-C at init's prompt is a refusal too - raw mode reads it as a character -
  # and somebody who meant to stop should not be asked for ever.
  for attempt in $(seq 1 "$FIRST_ADMIN_ATTEMPTS"); do
    if sudo -u "$SHOP_USER" "$node" "$SERVER" init "${name:-$fallback}"; then break; fi

    [ "$attempt" -lt "$FIRST_ADMIN_ATTEMPTS" ] || return 1
    say ''
    say 'That was not taken - the reason is just above. Once more:'
  done

  # AIDEV-NOTE: said here rather than left to the running message, because the machine that calls
  # this shop need not be the machine it is installed on - so the token is put somewhere by hand,
  # and this is the last moment anybody can read it.
  cat <<KEEPING

That token is the only copy. Wherever the client runs - this machine or another - it goes in the
file the client looks in, as whoever will be running it:

  mkdir -p ~/.config/3d-print-shop && chmod 700 ~/.config/3d-print-shop
  printf %s '<the token>' > ~/.config/3d-print-shop/token
  chmod 600 ~/.config/3d-print-shop/token
KEEPING
}

whatIsLeftToDo() {
  local node=$1

  cat <<NEXT

Installed, and not started: this shop has no callers yet, and one with none refuses to start.

Give it its first admin, as the user it runs as - the token is said once and kept nowhere else:

  sudo -u $SHOP_USER $node $SERVER init <your-name>

Then keep that token where the client looks for it, as whoever will be running it:

  mkdir -p ~/.config/3d-print-shop && chmod 700 ~/.config/3d-print-shop
  printf %s '<the token>' > ~/.config/3d-print-shop/token
  chmod 600 ~/.config/3d-print-shop/token

Then run this again to start it:

  sudo $(asTyped install)
NEXT
}

# AIDEV-NOTE: a shop with no callers refuses to start, and a supervisor would then restart it every
# few seconds for as long as the machine was up - a log nobody can read and a fault that reads like
# a bug. So it is given one HERE, while there is somebody to ask; and where there is nobody, the
# install stops and says the two commands rather than starting something that cannot come up.
gotItsFirstAdmin() {
  local node=$1

  if [ -f "$ETC/callers.json" ]; then return 0; fi

  if ! atATerminal; then
    whatIsLeftToDo "$node"
    return 1
  fi

  say ''
  say 'This shop has no callers yet, and one with none refuses to start - so, its first admin. The'
  say 'password is what they log in to the page with; the token is for a program that calls it.'
  say ''

  if madeTheFirstAdmin "$node"; then return 0; fi

  say ''
  say 'No admin was made, so the shop was not started. Everything else is in place - run this again'
  say "when you are ready, and it will ask again: sudo $(asTyped install)"
  return 1
}

# ---------------------------------------------------------------------------- what it does

install() {
  requireRoot install
  requireBuild
  requirePage

  local wanted node
  wanted=$(requiredNode)
  node=$(findNode "$wanted")

  if [ -z "$LISTEN" ]; then
    LISTEN=$(listenedOnBefore)
    [ -z "$LISTEN" ] || say "keeping --listen $LISTEN, which the service already installed was given"
  fi

  say 'the user it runs as:'
  if [ "$PLATFORM" = macos ]; then madeServiceUserOnMacos; else madeServiceUserOnLinux; fi

  say 'what it keeps its work and its credentials in:'
  madeDirectory "$JOBS"
  madeDirectory "$STATE"
  madeDirectory "$ETC"

  say 'the shop itself:'
  stopIt
  if [ "$MODE" = package ]; then
    say "  $(cd "$HERE/.." && pwd)  (where npm put it)"
  else
    copiedEverything
    say "  $INSTALL_DIR  (root, and readable by everybody - there is nothing secret in it)"
  fi

  say "  $PAGE  (the page it serves beside the API)"

  say 'what supervises it:'
  if [ "$PLATFORM" = macos ]; then
    wroteLog "$OUT_LOG"
    wroteLog "$ERR_LOG"
    wrotePlist "$node"
  else
    wroteUnit "$node"
  fi

  gotItsFirstAdmin "$node" || return 0

  startIt

  cat <<RUNNING

Installed and running, $(whereItAnswers)

  its log        $(reading)
  a new build    $(if [ "$MODE" = package ]; then printf 'sudo npm i -g @3d-print-shop/server @3d-print-shop/ui'; else printf 'sudo %s update' "$0"; fi)
  a credential   edit a file in $ETC, then $(reloading)
RUNNING
}

update() {
  requireRoot update
  requireBuild
  requirePage
  [ "$MODE" = checkout ] || refuse 'an installed package is updated by installing it again: sudo npm i -g @3d-print-shop/server @3d-print-shop/ui'
  isInstalled || refuse "there is no service to update - run 'sudo $(asTyped install)' first"

  stopIt
  copiedTheBuild
  chown -R "root:$ROOT_GROUP" "$INSTALL_DIR"
  chmod -R a+rX,go-w "$INSTALL_DIR"
  startIt

  say "the build in $REPO is now the one running - $(reading) to see it come up"
}

uninstall() {
  requireRoot uninstall

  stopIt
  if [ "$PLATFORM" = macos ]; then
    rm -f "$PLIST"
    say "stopped, and $PLIST is gone"
  else
    rm -f "$UNIT"
    systemctl daemon-reload
    say "stopped, and $UNIT is gone"
  fi

  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    say "$INSTALL_DIR is gone"
  fi

  # AIDEV-NOTE: the data holds work nobody has judged and /etc holds every token the shop knows.
  # Neither is this script's to throw away on the way out - uninstalling a service is not the same
  # act as discarding what it was holding, and one of them cannot be undone.
  cat <<KEPT

Left alone, because they hold work and secrets rather than installation:

  $JOBS   the work it was holding
  $STATE          its printers and sessions
  $ETC          its callers and its printer keys
  $SHOP_USER          the user that owns both

Remove them yourself if that is what you mean.
KEPT
}

# AIDEV-NOTE: wrapped and guarded so that SOURCING this file decides everything without doing
# anything - which is the seam its tests reach it through. Sourced, the mode, the paths, the platform
# and the node search have all been worked out and not one of them has written to a disk. Executed,
# `$0` is this file and `main` runs as it always did. Shadow `uname` before sourcing and the other
# platform's decisions are readable from this one, which is the only way the half that CI never runs
# on is testable at all.
# What was asked for: a command, which is `install` when none is named, and the options after it.
readArguments() {
  COMMAND=install
  case "${1:-}" in
    install | --install | update | --update | uninstall | --uninstall) COMMAND=${1#--}; shift ;;
    -h | --help | help) COMMAND=help; shift ;;
  esac

  while [ $# -gt 0 ]; do
    case "$1" in
      --listen)
        [ -n "${2:-}" ] || refuse '--listen needs an address - 0.0.0.0 for every one this machine has'
        LISTEN=$2
        shift 2
        ;;
      --listen=*)
        LISTEN=${1#--listen=}
        [ -n "$LISTEN" ] || refuse '--listen needs an address - 0.0.0.0 for every one this machine has'
        shift
        ;;
      *) usage >&2; exit 1 ;;
    esac
  done
}

main() {
readArguments "$@"

case "$COMMAND" in
  install) install ;;
  update) update ;;
  uninstall) uninstall ;;
  help) usage ;;
esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
