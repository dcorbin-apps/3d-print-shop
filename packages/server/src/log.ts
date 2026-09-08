/** What a line says besides its message. Values are rendered as `key=value`; nothing is read back. */
export type About = Record<string, unknown>;

// AIDEV-NOTE: two levels, not five. `note` is what an operator needs to see happened; `fault` is why
// something did not work. A shop that ran for eight hours has to be readable in one pass, and every
// level past these two is a decision at each call site that somebody eventually gets wrong.
export interface Log {
  happened(message: string, about?: About): void;
  failed(message: string, about?: About): void;
}

// AIDEV-NOTE: the default everywhere, so a unit test is silent without saying so and a component
// handed no log still runs. Silence is a decision the CALLER makes by not passing one.
export const silent: Log = {
  happened: () => undefined,
  failed: () => undefined,
};

const LEVELS = { note: 'note ', fault: 'fault' };

/**
 * One line per event: `<when> <level> <message>`, then whatever the line was about as `key=value`.
 *
 * Text rather than JSON, because the first reader of this is a person with a terminal and a wall of
 * objects is not a log they can skim. It stays greppable by date, by level and by message, which is
 * how a log is actually read.
 */
export function toStdout(now: () => Date = () => new Date(), write: (line: string) => void = console.log): Log {
  const at =
    (level: keyof typeof LEVELS) =>
    (message: string, about: About = {}): void =>
      write(`${now().toISOString()} ${LEVELS[level]} ${message}${saying(about)}`);

  return { happened: at('note'), failed: at('fault') };
}

// `key=value`, and quoted only when it would otherwise run into the next one. A value a person can
// read at a glance is worth more here than one a parser never has to think about.
function saying(about: About): string {
  const said = Object.entries(about)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${asValue(value)}`)
    .join(' ');

  return said === '' ? '' : ` ${said}`;
}

// AIDEV-NOTE: only a STRING is ever quoted, and only when it would otherwise run into the next
// pair. Anything else is already JSON and quoting that again escapes every quote inside it - which
// turned a list of two filaments into a line nobody could read.
function asValue(value: unknown): string {
  if (typeof value !== 'string') return JSON.stringify(value);

  return /[\s"]/.test(value) ? JSON.stringify(value) : value;
}

// AIDEV-NOTE: the rule arrives WITH the first line of logging rather than after the first leak. A
// printer's key and a caller's token are the two secrets this process holds, and the way either
// reaches a log is nobody's decision: an OctoPrint failure carrying its request headers, an express
// error quoting an Authorization header. So the sink refuses to write them at all, rather than every
// call site remembering - one place to get right, and a new call site cannot forget it.
//
// Over the whole of what a line says, message included: a secret may arrive nested, inside a URL, or
// in the middle of a sentence, and the point is that it never leaves this process.
export function redacting(log: Log, secrets: Iterable<string>): Log {
  // Empty and one-character secrets are refused rather than honoured: replacing "" or "a" everywhere
  // would shred every line, and a secret that short is not one.
  const worth = [...new Set(secrets)].filter((secret) => secret.trim().length > 1);
  const scrub = (text: string): string => worth.reduce((said, secret) => said.split(secret).join('[redacted]'), text);

  const scrubbed = (about: About = {}): About => JSON.parse(scrub(JSON.stringify(about))) as About;

  return {
    happened: (message, about) => log.happened(scrub(message), scrubbed(about)),
    failed: (message, about) => log.failed(scrub(message), scrubbed(about)),
  };
}
