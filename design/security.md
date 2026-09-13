# What the shop lets somebody do, and what stops somebody else

The design this serves is in [3d-print-shop.md](3d-print-shop.md), under "Who may ask, and what is
theirs" - who a caller is, what a role buys, and what ownership means. This is the other half: what
stops a request that is not really theirs, and why each rule is not the one next to it. What is still
open is in [PLAN.md](../PLAN.md), under Security.

## Two kinds of caller, two kinds of credential

A machine presents a **token** - 32 random bytes of the shop's own making, kept as a plain digest
because guessing one is not a thing that happens and the only job of the hash is that the file cannot
be read back into a way in. A token is a map lookup, which is what a credential on every single
request has to be.

A person presents a **password**, at a browser, and gets a **session** back. A password is guessable
because a person chose it, so it costs scrypt and a salt of its own. Doing this the other way round
is the trap: scrypt on every token would put a memory-hard function in front of every request, and a
plain digest on a password would make the file a wordlist away from being a set of passwords.

The session is a cookie rather than something the page keeps, and the page never sees it. A script
that can read a credential is a script that can send one somewhere else.

## What stops another site acting as somebody

Three rules, and none of them is a spare copy of another.

**The cookie is `SameSite=Strict`.** This is the shop telling the browser: only attach this cookie to
requests that started on my own page. It is what makes a form on another site unable to act as
whoever is logged in here.

**The guard asks a session-carrying write where it came from.** SameSite is a rule the *browser*
keeps; this is the shop keeping it too, against the Host the request arrived at rather than anything
configured - the shop does not know its own name, and whatever reached it is what a page it served
would say. A token needs none of this: nothing sends one on anybody's behalf.

**The login asks the same question.** This is the one that reads like a duplicate and is not.
`POST /sessions` is registered above the guard, because there is nowhere else for somebody with a
password and no session to start - so it is the one route the guard never sees. And SameSite does not
reach it, because **SameSite governs whether a cookie is SENT, and says nothing about whether a
`Set-Cookie` is STORED.** Without the rule at this route, a page on another site could post a login of
its own choosing, leave a browser holding a session belonging to whoever it picked, and read back
afterwards whatever was submitted through it. The attack runs backwards from the one SameSite is for:
it does not take your session, it gives you theirs.

It is asked before the body is read and before the guess is counted, so a login the shop will not act
on costs no hashing and spends nobody's attempts - otherwise another site could burn a caller's
guesses for them and leave them locked out without ever reaching a password.

What it costs is worth saying plainly: **a password is a browser's credential now.** Something with no
page to log in from presents a token, which is already what the shop gives a machine. Nothing the shop
ships logs in any other way.

A dev server proxying to the shop has to forward the Host as the browser sent it rather than
rewriting it to the target's - otherwise the origin and the host disagree and every write is refused.
That is not a special case for the login; it is what every session-carrying write already needed.

## What is deliberately accepted

**A printer's address is not range-checked.** An admin may point a printer at any http or https
address, and the shop will POST a plate's gcode there with that printer's key on it. A range check
when the printer is added does not hold - a hostname resolves at connect time rather than then, and a
printer reached over a VPN is legitimate - and only an admin may add one at all, which is close to
what admin means.

**The interface is the outer wall.** A token travels in the clear over http, so the default is
loopback and reaching further is something an operator asks for with `serve --listen`. The cookie is
marked `Secure` only when the request actually arrived over TLS, because a shop on loopback http would
otherwise set a cookie the browser refuses to send back. Behind a TLS-terminating proxy that is worth
revisiting, along with what the shop then believes about a request's address.

**An admin may judge work that is not theirs, and afterwards nothing says they did.** That is the
price of never holding a bed for a job nobody is left to judge, and the argument it makes is for the
logging rather than for a field on a record that is written once.
