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

## Guessing a password, and being held out of your own account

Wrong guesses are counted against the **id** and nothing else. Counting them against the address as
well was the obvious thing and was the bug: the shop listens on loopback, so the address never
varies and one bucket was every caller's - four wrong guesses against a name the shop did not even
have put everybody else behind a five-minute wait while holding the right password.

Three misses are free, then the wait doubles to a cap. The wait is read **before** the password is,
which is what keeps a guesser from spending the shop's scrypt - and it is also why a caller who is
being held out cannot clear it by knowing their own password. Nothing checks a password to find out
whether to honour a wait, because checking one is the cost the wait exists to bound.

That makes the relation between two constants load-bearing, which is the kind of thing that reads as
a coincidence unless it is said. `mustWait` expires an entry before it reads a wait off one, so the
longest anybody is held is `min(cap, forget window)`. **The cap is therefore the forget window, and
never less than it.** While the cap was the shorter of the two - five minutes against fifteen - there
was a moment every five minutes when the wait had run out and the count had not yet gone cold, and a
single wrong guess landed in it put the clock back. Twelve requests an hour held a caller out of
their own account for as long as somebody cared to keep going.

The alternative considered and rejected was to check the password first and let a right one through
whatever the wait says. It removes the lockout, and it removes the only bound on how many guesses may
be aimed at one name: the guess rate against a targeted caller goes from a handful per quarter-hour
to whatever the process can hash, which against a password whose only rule is twelve characters is a
worse trade than the one it fixes.

What is NOT answered here is how much hashing the process will do in total - a guesser varying the id
never accumulates a count and buys a scrypt per request. That is a question about a resource rather
than about anybody's credential, and `HASHES_AT_ONCE` in `secrets.ts` answers it: half the libuv
threadpool, so a login flood makes logging in slow and leaves the shop printing through it.

## Writing the files the credentials are in

Both credential files are changed by reading the whole file, changing it, writing beside it and
renaming over. That shape is right - a rename is atomic and a write is not - and it has two hazards,
answered separately because they are not the same hazard.

**A shared scratch path was the dangerous one.** `writeFile` truncates on open and writes from nought
on a handle of its own, so two writes to one scratch path leave the shorter one's bytes with the
longer one's tail behind them. What gets renamed into place is then not JSON, over the credentials of
every caller the shop knows. A shop already running survives it - it keeps the callers it holds and
says why - but the next restart refuses to start, and the fix is a person with a text editor. Every
write now names its own scratch, so there is nothing to collide over and nothing left behind for a
later writer to interpret.

**The lost change is the other, and how far it can be answered depends on who is writing.**
`printer-keys.json` has one writer, the running shop, so its read-modify-write is serialised in
process and that is the whole of it. `callers.json` has two: the shop, when somebody changes their
own password over the API, and the operator's terminal, where `caller add`, `caller password`,
`caller token` and `callers migrate` write it directly. That is deliberate - a shop cannot be asked to
give somebody a way in that it does not yet answer, which is also why there is no route for changing
anybody else's password. Serialising covers the shop's half and cannot reach the other.

**So the remaining race is detected rather than prevented.** A lock those two processes could share
would have to be a file, and a file outlives the process that took it - the complaint `dataLock.ts`
makes when it reaches for a listening socket instead, and a socket is the wrong shape for a
fifty-millisecond turn taken over and over. What actually does the damage is not the lost write but
the route acting as though it took: `PUT /me/password` ends every other session that caller holds and
answers 204, which would leave them logged out everywhere holding a password the file does not have.
So the write is read back and checked, and a change that was overwritten is refused - a 500, because
the shop failed rather than the caller - and can simply be made again.

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
