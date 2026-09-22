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

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# AIDEV-NOTE: two ways this file is reached, and the difference is who put the code somewhere the
# service can read. Exploded by npm, the server is a sibling in the same scope and npm has already
# resolved everything it needs - so there is nothing to copy and copying would be a second, staler
# tree. In a checkout there is a build, sitting where a daemon cannot get at it.
case "$HERE" in
  */node_modules/@3d-print-shop/installer) MODE=package ;;
  *) MODE=checkout ;;
esac

# AIDEV-NOTE: npm does NOT hoist a global install's dependencies up into the scope directory - it
# nests them under the installed package's own node_modules, so the server is at
# `installer/node_modules/@3d-print-shop/server` and NOT at `installer/../server`. A local install
# hoists and gives the second shape, so both are real layouts and both are looked for. Measured
# against npm 11 on Linux, after a global install refused itself by looking only where nothing was.
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
  BUILT=$(packagedAt server/dist/main.js)
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
usage: sudo $0 [install|update|uninstall]

install    make the data and credentials directories, the user that owns them, the copy of the
           shop the service runs, and the service itself
update     copy a fresh build over the installed one and restart - what to run after 'yarn build',
           and only from a checkout: an installed package is updated by installing it again
uninstall  stop the service and remove it - the data, the credentials and the user are left,
           because they hold work and secrets this script did not create
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

  if [ "$MODE" = package ]; then
    refuse "$BUILT_PAGE is not there - @3d-print-shop/ui is not installed beside this"
  fi

  refuse "$BUILT_PAGE is not there - run 'yarn install && yarn build' in $REPO first, which builds it"
}

requireBuild() {
  if [ ! -f "$BUILT" ]; then
    if [ "$MODE" = package ]; then
      refuse "$BUILT is not there - @3d-print-shop/server is not installed beside this"
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
$(pageArguments)  </array>
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

  # Restart=on-failure rather than always, for the reason the plist keeps KeepAlive conditional:
  # `3d-print-shop shutdown` is somebody asking it to stop. stdout is the shop's log and journald is
  # what captures it, so there is no file here to rotate.
  cat >"$UNIT" <<UNIT
[Unit]
Description=3D Print Shop
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$node $SERVER serve$(pageOption)
ExecReload=/bin/kill -HUP \$MAINPID
User=$SHOP_USER
Group=$SHOP_GROUP
WorkingDirectory=$STATE
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

# AIDEV-NOTE: npm hides a DEPENDENCY's postinstall output and hands it a pipe for stdin - and this
# package is never the root one, so that is every install of it. Everything said from in there is
# invisible and nothing asked can be answered, which is how an install that stopped short to ask for
# its first admin looked, from the outside, like an install that did nothing at all. The controlling
# terminal is untouched by any of that and can simply be taken, and taking it fixes both halves at
# once: what is said arrives, and what is asked can be answered.
#
# Measured against npm 10 on Linux, where a dependency's postinstall has `[ -t 0 ]` false, its stdout
# swallowed, and /dev/tty open to it. Where there is no controlling terminal at all - CI, a container
# build, a machine provisioning itself - nothing is taken and `atATerminal` reads that correctly.
tookTheTerminal() {
  if ! (exec 3<>/dev/tty) 2>/dev/null; then return 1; fi

  exec </dev/tty >/dev/tty 2>&1
}

# AIDEV-NOTE: a function rather than `[ -t 0 ]` written where it is asked, because there are two
# callers of `install` and only one of them has a person at a keyboard. npm's postinstall owns
# stdin, and `init` asks for a password - so asking there is a prompt nobody can see, waiting on an
# answer nobody can give. It is also the seam the tests read the other branch through.
atATerminal() { [ -t 0 ]; }

# AIDEV-NOTE: run as the SERVICE user, because $ETC is 0700 and theirs - a credentials file written
# by root is one the shop cannot read. `init` asks for the password itself and says the token once,
# so neither ever passes through this script, which is what keeps the rule at the top of this file
# true: nothing here writes a credential.
madeTheFirstAdmin() {
  local node=$1 name='' fallback=${SUDO_USER:-admin}

  read -r -p "what to call the first admin, and own every job of theirs [$fallback]: " name || true
  sudo -u "$SHOP_USER" "$node" "$SERVER" init "${name:-$fallback}" || return 1

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

Each printer's API key goes in $ETC/printer-keys.json as {"mk4": "..."}, 0600 and owned by
$SHOP_USER. Then run this again to start it:

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

  whatIsLeftToDo "$node"
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

Installed and running, on http://localhost:7373 - loopback, which is where a token travelling in
the clear belongs.

  its log        $(reading)
  a new build    $(if [ "$MODE" = package ]; then printf 'sudo npm i -g @3d-print-shop/installer'; else printf 'sudo %s update' "$0"; fi)
  a credential   edit a file in $ETC, then $(reloading)
RUNNING
}

update() {
  requireRoot update
  requireBuild
  requirePage
  [ "$MODE" = checkout ] || refuse 'an installed package is updated by installing it again: sudo npm i -g @3d-print-shop/installer'
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
main() {
case "${1:-install}" in
  # AIDEV-NOTE: what npm's postinstall calls, and it is a separate word from `install` because yarn
  # runs it on every install in the CHECKOUT too, where nobody asked for a daemon and there is
  # nothing to explode. It also must not fail: a postinstall that exits non-zero fails the whole npm
  # install, so a person who has not used sudo is told what to type rather than shouted at.
  #
  # npm drops to the owner of its prefix when it is run as root, so being root here is not something
  # to count on even under sudo.
  from-npm)
    [ "$MODE" = package ] || exit 0

    # Before anything is said, because npm is holding the pen until this is done.
    tookTheTerminal || true

    if [ "$(id -u)" != 0 ]; then
      say "3d-print-shop is unpacked. It makes a system user, a data directory and a daemon, so the install
itself is one more command: sudo 3d-print-shop-install"
      exit 0
    fi

    install
    ;;
  install | --install) install ;;
  update | --update) update ;;
  uninstall | --uninstall) uninstall ;;
  -h | --help | help) usage ;;
  *) usage >&2; exit 1 ;;
esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
