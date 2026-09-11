// AIDEV-NOTE: /var/spool is where a system's spoolers keep outstanding work, and macOS has it too -
// BSD-derived, with the same occupants Linux has (cups, postfix, mqueue, uucp). So one path serves
// both platforms and there is no branch to test.
//
// Not a per-user directory. A running service's work does not belong in somebody's home, and the
// service may not run as the person who submitted the job.
const SYSTEM_DATA_ROOT = '/var/spool/3d-print-shop';

// `3D_` is not a legal start for an environment variable, so the digit is dropped rather than
// spelled out.
export const DATA_ROOT_ENV = 'PRINT_SHOP_DATA';

export function defaultDataRoot(): string {
  return process.env[DATA_ROOT_ENV] ?? SYSTEM_DATA_ROOT;
}
