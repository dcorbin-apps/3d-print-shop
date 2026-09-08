/** What a line says besides its name. Values are whatever JSON carries; nothing here is read back. */
export type About = Record<string, unknown>;

// AIDEV-NOTE: two levels, not five. `note` is what an operator needs to see happened; `fault` is why
// something did not work. A shop that ran for eight hours has to be readable in one pass, and every
// level past these two is a decision somebody has to make at each call site and then get wrong.
export interface Log {
  happened(event: string, about?: About): void;
  failed(event: string, about?: About): void;
}

// AIDEV-NOTE: the default everywhere, so a unit test is silent without saying so and a component
// that is handed no log still runs. Silence is a decision the CALLER makes by not passing one.
export const silent: Log = {
  happened: () => undefined,
  failed: () => undefined,
};

/**
 * One JSON object per line, to stdout.
 *
 * stdout because `launchd` and `systemd` both capture it, which is a log the shop does not have to
 * open, rotate or lose - and one line per event because the alternative is a format that has to be
 * parsed back out of prose the day anybody wants to count anything.
 */
export function toStdout(now: () => Date = () => new Date(), write: (line: string) => void = console.log): Log {
  const line =
    (level: 'note' | 'fault') =>
    (event: string, about: About = {}): void =>
      write(JSON.stringify({ at: now().toISOString(), level, event, ...about }));

  return { happened: line('note'), failed: line('fault') };
}

// AIDEV-NOTE: the rule arrives WITH the first line of logging rather than after the first leak. A
// printer's key and a caller's token are the two secrets this process holds, and the way either
// reaches a log is nobody's decision: an OctoPrint failure carrying its request headers, an express
// error quoting an Authorization header. So the sink refuses to write them at all, rather than every
// call site remembering - one place to get right, and it cannot be forgotten at a new one.
//
// Whole-string, on the rendered line: a secret may arrive nested, in a message, or inside a URL, and
// the point is that it never leaves this process rather than that the field it sat in is tidy.
export function redacting(log: Log, secrets: Iterable<string>): Log {
  // Empty and one-character secrets are refused rather than honoured: replacing "" or "a" everywhere
  // would shred every line, and a secret that short is not one.
  const worth = [...new Set(secrets)].filter((secret) => secret.trim().length > 1);

  const scrub = (about: About = {}): About => {
    const said = JSON.stringify(about);
    const clean = worth.reduce((text, secret) => text.split(secret).join('[redacted]'), said);

    return JSON.parse(clean) as About;
  };

  return {
    happened: (event, about) => log.happened(event, scrub(about)),
    failed: (event, about) => log.failed(event, scrub(about)),
  };
}
