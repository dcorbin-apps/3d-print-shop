import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Role } from '@3d-print-shop/client/browser';
import { App } from '../src/App';

// AIDEV-NOTE: fetch is stubbed rather than the client mocked, so what is under test is the page AND
// the contract it speaks - a route renamed at one end would be caught here. What the shop does with
// any of these is the server's own suite; this is only about what the page asks and what it shows.
describe('the page, against a shop that answers', () => {
  const fetching = jest.fn<typeof fetch>();

  // AIDEV-NOTE: what HttpShop actually reads off a response - `ok`, `status`, `json()` - rather than
  // a real Response, which jsdom does not have. Built as a Response so the types still line up; a
  // stub that threw would be indistinguishable from a shop that could not be reached, because
  // `attempt` rewrites anything fetch throws into exactly that.
  const answered = (body: unknown): Response => ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;

  const refused = (status: number): Response =>
    ({ ok: false, status, json: () => Promise.resolve({ error: 'this shop does not know that token' }) }) as Response;

  const answering = (as: Role): void => {
    fetching.mockImplementation((asked: Parameters<typeof fetch>[0]) => {
      const path = String(asked);
      if (path.endsWith('/me')) return Promise.resolve(answered({ id: 'dave', name: 'dave', role: as }));
      if (path.endsWith('/printers')) return Promise.resolve(answered([]));

      return Promise.resolve(answered({ accessibleJobs: [], totalJobs: 0 }));
    });
  };

  const asked = (method: string, path: string): RequestInit | undefined =>
    fetching.mock.calls.find(([where, sent]) => String(where) === path && sent?.method === method)?.[1];

  beforeEach(() => {
    global.fetch = fetching;
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  // AIDEV-NOTE: a browser nobody has logged in on, and a browser whose session expired while it sat
  // there, are the same thing to this page - both are a stranger, and both want a login where the
  // page was rather than an error.
  it('asks a stranger to log in', async () => {
    fetching.mockImplementation(() => Promise.resolve(refused(401)));

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Who')).toBeDefined());
    expect(screen.getByLabelText('Password')).toBeDefined();
  });

  it('logs in with what was typed, and asks the shop again once it is in', async () => {
    fetching.mockImplementation(() => Promise.resolve(refused(401)));
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('Who')).toBeDefined());

    answering('admin');
    fireEvent.change(screen.getByLabelText('Who'), { target: { value: 'dave' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a password of some length' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(asked('POST', '/sessions')).toBeDefined());
    expect(JSON.parse(String(asked('POST', '/sessions')?.body))).toEqual({ id: 'dave', password: 'a password of some length' });
  });

  // Nothing is kept: what logging in produces is a cookie the shop set, which this page cannot read.
  it('keeps nothing of the password or the session in the browser', async () => {
    fetching.mockImplementation(() => Promise.resolve(refused(401)));
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('Who')).toBeDefined());

    answering('admin');
    fireEvent.change(screen.getByLabelText('Who'), { target: { value: 'dave' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a password of some length' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(asked('POST', '/sessions')).toBeDefined());
    expect(JSON.stringify(window.localStorage)).not.toContain('a password of some length');
  });

  it('says who it is logged in as, on a screen anybody may walk up to', async () => {
    answering('admin');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: /dave/ })).toBeDefined());
  });

  it('logs out at the shop rather than only in the browser', async () => {
    answering('admin');
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: /dave/ })).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /dave/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));

    await waitFor(() => expect(asked('DELETE', '/sessions')).toBeDefined());
  });

  it('asks the shop who the caller is before deciding what to offer', async () => {
    answering('user');

    render(<App />);

    await waitFor(() => expect(fetching.mock.calls.map(([asked]) => String(asked))).toContain('/me'));
  });

  // The whole of the requirement: adding a printer is an admin's, and the page is told which the
  // caller is rather than offering it to everybody and letting the shop's refusal teach them.
  it('offers an admin the way to add a printer', async () => {
    answering('admin');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a printer' })).toBeDefined());
  });

  it('offers a user nothing of the sort', async () => {
    answering('user');

    render(<App />);

    // Waited for rather than asserted straight away: absent because the answer has not arrived yet
    // would pass without proving anything.
    await waitFor(() => expect(screen.getByText(/No printers/)).toBeDefined());
    expect(screen.queryByRole('button', { name: 'Add a printer' })).toBeNull();
  });

  // AIDEV-NOTE: the whole point of the form, end to end from the page: a machine and the key the
  // shop reaches it with, in ONE call - a printer must not be able to land without the key it is
  // reached by and leave somebody to work out which half happened.
  it('adds a printer and its key in one call', async () => {
    answering('admin');
    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a printer' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Add a printer' }));

    (
      [
        ['name', 'mk4'],
        ['width', '250'],
        ['depth', '210'],
        ['height', '220'],
        ['address', 'http://octopi.local'],
        ['api key', 'mk4-key'],
      ] as const
    ).forEach(([field, said]) => {
      fireEvent.change(screen.getByLabelText(field, { exact: false }), { target: { value: said } });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(asked('POST', '/printers')).toBeDefined());

    expect(JSON.parse(String(asked('POST', '/printers')?.body))).toEqual({
      name: 'mk4',
      buildVolume: { x: 250, y: 210, z: 220 },
      api: 'octoprint',
      address: 'http://octopi.local',
      key: 'mk4-key',
    });

    // One call, and only one: nothing else was asked of the shop to finish adding it.
    expect(fetching.mock.calls.filter(([, sent]) => sent?.method !== 'GET')).toHaveLength(1);
  });

  // AIDEV-NOTE: changing a printer is the SAME call as adding one, under the name it already has -
  // and a key left blank is not sent at all, which is the contract's "keep the one it has". Sending
  // an empty one would be a printer the shop can no longer reach.
  it('changes a printer through the same call, keeping its key when none is typed', async () => {
    const mk4 = { name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://prusa.local', loaded: [] };
    fetching.mockImplementation((where: Parameters<typeof fetch>[0]) => {
      const path = String(where);
      if (path.endsWith('/me')) return Promise.resolve(answered({ id: 'dave', name: 'dave', role: 'admin' }));
      if (path.endsWith('/printers')) return Promise.resolve(answered([mk4]));

      return Promise.resolve(answered({ accessibleJobs: [], totalJobs: 0 }));
    });
    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit mk4' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Edit mk4' }));
    fireEvent.change(screen.getByLabelText('address', { exact: false }), { target: { value: 'http://prusa.home.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(asked('POST', '/printers')).toBeDefined());
    expect(JSON.parse(String(asked('POST', '/printers')?.body))).toEqual({
      name: 'mk4',
      buildVolume: { x: 250, y: 210, z: 220 },
      api: 'octoprint',
      address: 'http://prusa.home.example',
    });
  });

  // The wire end of loading: the same PUT the operator's `printer load` makes, and only for an admin.
  describe('loading a printer', () => {
    const withMk4 = (as: Role): void => {
      const mk4 = { name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://prusa.local', loaded: [] };
      fetching.mockImplementation((where: Parameters<typeof fetch>[0], sent?: RequestInit) => {
        const path = String(where);
        if (path.endsWith('/me')) return Promise.resolve(answered({ id: 'dave', name: 'dave', role: as }));
        if (path.endsWith('/printers')) return Promise.resolve(answered([mk4]));
        if (sent?.method === 'PUT') return Promise.resolve(answered({ ...mk4, loaded: ['PLA'] }));

        return Promise.resolve(
          answered({
            accessibleJobs: [
              { id: 2, displayName: 'Markers', filaments: ['PLA'], submittedAt: '2026-09-09T12:00:00Z', gcodeBytes: 1024, state: 'queued' },
              {
                id: 7,
                displayName: 'Player Box',
                filaments: ['PLA-Red'],
                submittedAt: '2026-09-09T12:00:00Z',
                gcodeBytes: 1024,
                state: 'awaiting-approval',
                heldBy: 'mk4',
                lastPrinterOutcome: 'finished',
              },
            ],
            totalJobs: 2,
          }),
        );
      });
    };

    it('tells the shop what an admin put on the machine', async () => {
      withMk4('admin');
      render(<App />);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Load mk4' })).toBeDefined());

      fireEvent.click(screen.getByRole('button', { name: 'Load mk4' }));
      fireEvent.change(screen.getByLabelText('Filament loaded'), { target: { value: 'PLA' } });
      fireEvent.click(screen.getByRole('button', { name: 'Load' }));

      await waitFor(() => expect(asked('PUT', '/printers/mk4/filament')).toBeDefined());
      expect(JSON.parse(String(asked('PUT', '/printers/mk4/filament')?.body))).toEqual({ loaded: ['PLA'] });
    });

    // A print waiting for a verdict needs nothing loaded, so its filament is not suggested.
    it('suggests only what queued work is waiting for', async () => {
      withMk4('admin');
      render(<App />);
      await waitFor(() => expect(screen.getByText('Markers')).toBeDefined());

      fireEvent.click(screen.getByRole('button', { name: 'Load mk4' }));
      const field = screen.getByLabelText('Filament loaded') as HTMLInputElement;

      expect([...(field.list?.options ?? [])].map((option) => option.value)).toEqual(['PLA']);
    });

    it('loads what a group waits for on the chosen machine', async () => {
      withMk4('admin');
      render(<App />);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Load on mk4' })).toBeDefined());

      fireEvent.click(screen.getByRole('button', { name: 'Load on mk4' }));

      await waitFor(() => expect(asked('PUT', '/printers/mk4/filament')).toBeDefined());
      expect(JSON.parse(String(asked('PUT', '/printers/mk4/filament')?.body))).toEqual({ loaded: ['PLA'] });
    });

    // Loading what a queued job waits for starts it, and the page should show that without a tick.
    it('asks the shop again at once rather than waiting for the next poll', async () => {
      withMk4('admin');
      render(<App />);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Load on mk4' })).toBeDefined());
      const askedBefore = fetching.mock.calls.filter(([where]) => String(where) === '/printers').length;

      fireEvent.click(screen.getByRole('button', { name: 'Load on mk4' }));

      await waitFor(() => expect(fetching.mock.calls.filter(([where]) => String(where) === '/printers').length).toBeGreaterThan(askedBefore));
    });

    it('is not offered to a user, on the machine or on the work', async () => {
      withMk4('user');
      render(<App />);

      await waitFor(() => expect(screen.getByText('Markers')).toBeDefined());
      expect(screen.queryByRole('button', { name: 'Load mk4' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Load on mk4' })).toBeNull();
    });
  });

  // The wire end of stopping, starting and removing: the same requests the operator's `printer stop`,
  // `printer start` and `printer remove` make, and only for an admin.
  describe('stopping, starting and removing a printer', () => {
    const asking = window.confirm;

    afterEach(() => {
      window.confirm = asking;
    });

    const withMk4 = (as: Role, trouble: Record<string, unknown> = {}): void => {
      const mk4 = {
        name: 'mk4',
        buildVolume: { x: 250, y: 210, z: 220 },
        api: 'octoprint',
        address: 'http://prusa.local',
        loaded: [],
        ...trouble,
      };
      fetching.mockImplementation((where: Parameters<typeof fetch>[0], sent?: RequestInit) => {
        const path = String(where);
        if (path.endsWith('/me')) return Promise.resolve(answered({ id: 'dave', name: 'dave', role: as }));
        if (path.endsWith('/printers')) return Promise.resolve(answered([mk4]));
        if (sent?.method === 'PUT') return Promise.resolve(answered(mk4));
        if (sent?.method === 'DELETE') return Promise.resolve({ ok: true, status: 204 } as Response);

        return Promise.resolve(answered({ accessibleJobs: [], totalJobs: 0 }));
      });
    };

    const pressWhenThere = async (name: string): Promise<void> => {
      await waitFor(() => expect(screen.getByRole('button', { name })).toBeDefined());
      fireEvent.click(screen.getByRole('button', { name }));
    };

    const statusSent = (): unknown => JSON.parse(String(asked('PUT', '/printers/mk4/status')?.body));

    it('tells the shop a printer refused a plate may try again', async () => {
      withMk4('admin', { refused: { reason: 'Prusa Mk4 refused the file', since: '2026-10-17T09:00:00Z' } });
      render(<App />);

      await pressWhenThere('Try mk4 again');

      await waitFor(() => expect(asked('PUT', '/printers/mk4/status')).toBeDefined());
      expect(statusSent()).toEqual({ stopped: false });
    });

    it('tells the shop to stop a printer, and why', async () => {
      withMk4('admin');
      render(<App />);
      await pressWhenThere('Stop mk4');

      fireEvent.change(screen.getByLabelText('Why it is stopping'), { target: { value: 'clearing a jam' } });
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

      await waitFor(() => expect(asked('PUT', '/printers/mk4/status')).toBeDefined());
      expect(statusSent()).toEqual({ stopped: true, reason: 'clearing a jam' });
    });

    it('tells the shop to take a printer out', async () => {
      window.confirm = (): boolean => true;
      withMk4('admin');
      render(<App />);
      await pressWhenThere('Edit mk4');

      fireEvent.click(screen.getByRole('button', { name: 'Remove mk4' }));

      await waitFor(() => expect(asked('DELETE', '/printers/mk4')).toBeDefined());
    });

    it('offers a user none of it', async () => {
      withMk4('user', { paused: { reason: 'clearing the bed', since: '2026-10-17T09:30:00Z' } });
      render(<App />);

      await waitFor(() => expect(screen.getByRole('button', { name: /mk4/ })).toBeDefined());
      expect(screen.queryByRole('button', { name: /^(Start|Stop|Edit) mk4$/ })).toBeNull();
    });
  });

  // AIDEV-NOTE: the verdict end to end from the page - the one thing that frees a bed, which until
  // now meant walking to a terminal while the machine that finished stood holding it.
  describe('judging a print that has finished', () => {
    const holding = (as: Role = 'user'): void => {
      fetching.mockImplementation((where: Parameters<typeof fetch>[0], sent?: RequestInit) => {
        const path = String(where);
        if (path.endsWith('/me')) return Promise.resolve(answered({ id: 'dave', name: 'dave', role: as }));
        if (path.endsWith('/printers')) return Promise.resolve(answered([]));
        if (sent?.method === 'PUT') return Promise.resolve(answered(undefined));

        return Promise.resolve(
          answered({
            accessibleJobs: [
              {
                id: 7,
                displayName: 'Player Box',
                filaments: ['PLA-Red'],
                submittedAt: '2026-09-09T12:00:00Z',
                gcodeBytes: 1024,
                state: 'awaiting-approval',
                heldBy: 'mk4',
                lastPrinterOutcome: 'finished',
              },
            ],
            totalJobs: 1,
          }),
        );
      });
    };

    it('tells the shop what the person sitting in front of it said', async () => {
      holding();
      render(<App />);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Approve job 7' })).toBeDefined());

      fireEvent.click(screen.getByRole('button', { name: 'Approve job 7' }));

      await waitFor(() => expect(asked('PUT', '/jobs/7/verdict')).toBeDefined());
      expect(JSON.parse(String(asked('PUT', '/jobs/7/verdict')?.body))).toEqual({ verdict: 'approved' });
    });

    // Not left until the next tick: a verdict frees a bed, the next job starts on that machine, and
    // the page somebody just judged on should be showing that rather than the last poll's answer.
    it('asks the shop again at once rather than waiting for the next poll', async () => {
      holding();
      render(<App />);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Approve job 7' })).toBeDefined());
      const askedBefore = fetching.mock.calls.filter(([where]) => String(where) === '/jobs').length;

      fireEvent.click(screen.getByRole('button', { name: 'Approve job 7' }));

      await waitFor(() => expect(fetching.mock.calls.filter(([where]) => String(where) === '/jobs').length).toBeGreaterThan(askedBefore));
    });

    // It is the owner's, or an admin's, and which is which is the shop's to say - so the page offers
    // it against every job it was shown, and shows what the shop said if it will not take one.
    it('is offered to a user, on the work the shop showed them', async () => {
      holding('user');

      render(<App />);

      await waitFor(() => expect(screen.getByRole('button', { name: 'Give up job 7' })).toBeDefined());
    });
  });

  // An admin's alone, because it puts a job ahead of everybody's - and the shop refuses anybody else.
  describe('promoting a queued job', () => {
    const queued = (as: Role): void => {
      fetching.mockImplementation((where: Parameters<typeof fetch>[0], sent?: RequestInit) => {
        const path = String(where);
        if (path.endsWith('/me')) return Promise.resolve(answered({ id: 'dave', name: 'dave', role: as }));
        if (path.endsWith('/printers')) return Promise.resolve(answered([]));
        if (sent?.method === 'PUT') return Promise.resolve(answered({ id: 7, filaments: ['PLA-Red'], submittedAt: '2026-09-09T12:00:00Z' }));

        return Promise.resolve(
          answered({
            accessibleJobs: [
              {
                id: 7,
                displayName: 'Player Box',
                filaments: ['PLA-Red'],
                submittedAt: '2026-09-09T12:00:00Z',
                gcodeBytes: 1024,
                state: 'queued',
              },
            ],
            totalJobs: 1,
          }),
        );
      });
    };

    it('tells the shop which job an admin sent to the front', async () => {
      queued('admin');
      render(<App />);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Promote job 7' })).toBeDefined());

      fireEvent.click(screen.getByRole('button', { name: 'Promote job 7' }));

      await waitFor(() => expect(asked('PUT', '/jobs/7/promotion')).toBeDefined());
    });

    it('is not offered to a user', async () => {
      queued('user');
      render(<App />);

      await waitFor(() => expect(screen.getByRole('button', { name: 'Pause job 7' })).toBeDefined());
      expect(screen.queryByRole('button', { name: 'Promote job 7' })).toBeNull();
    });
  });

  // AIDEV-NOTE: their own password, end to end from the page - which until now was an operator at a
  // terminal, and so was nothing the person whose password it is could do.
  describe('changing your own password', () => {
    const changeIt = async (): Promise<void> => {
      answering('user');
      render(<App />);
      await waitFor(() => expect(screen.getByRole('button', { name: /dave/ })).toBeDefined());

      fireEvent.click(screen.getByRole('button', { name: /dave/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Change password' }));

      (
        [
          ['current password', 'the password in use'],
          ['new password', 'a different password entirely'],
          ['repeat the new one', 'a different password entirely'],
        ] as const
      ).forEach(([field, said]) => {
        fireEvent.change(screen.getByLabelText(field, { exact: false }), { target: { value: said } });
      });

      fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    };

    it('sends the shop the one in use and the one wanted', async () => {
      await changeIt();

      await waitFor(() => expect(asked('PUT', '/me/password')).toBeDefined());
      expect(JSON.parse(String(asked('PUT', '/me/password')?.body))).toEqual({
        current: 'the password in use',
        password: 'a different password entirely',
      });
    });

    // The session that asked is the one the shop keeps, so the page it was asked from goes on
    // working - being asked to log in again for having just proved who you are is a page that
    // punishes the safe thing.
    it('leaves the browser that asked logged in', async () => {
      await changeIt();

      await waitFor(() => expect(screen.getByText(/Password changed/)).toBeDefined());
      expect(screen.queryByLabelText('Who')).toBeNull();
    });
  });

  // AIDEV-NOTE: no token and no Authorization header - a browser is named by the session cookie the
  // shop set, which this page never sees. `credentials: 'include'` is what makes a browser send it.
  it('carries nothing of its own, and lets the browser send the cookie', async () => {
    answering('admin');

    render(<App />);

    await waitFor(() => expect(fetching).toHaveBeenCalled());
    const [, sent] = fetching.mock.calls[0];

    expect((sent?.headers as Record<string, string>).authorization).toBeUndefined();
    expect(sent?.credentials).toBe('include');
  });

  // A shop that is being restarted, or a token it no longer knows.
  it('says what went wrong when the shop will not answer', async () => {
    fetching.mockRejectedValue(new Error('connect ECONNREFUSED'));

    render(<App />);

    await waitFor(() => expect(screen.getByText(/Cannot reach the print shop/)).toBeDefined());
  });

  // AIDEV-NOTE: the page and the shop are two packages and can come from different releases. Only
  // THAT it says so, and where, is here - what it says is versionDrift's suite.
  describe('a shop from another release', () => {
    const answeringAsRelease = (version: string): void => {
      fetching.mockImplementation((asked: Parameters<typeof fetch>[0]) => {
        const path = String(asked);
        if (path.endsWith('/me')) return Promise.resolve(answered({ id: 'dave', name: 'dave', role: 'admin' }));
        if (path.endsWith('/version')) return Promise.resolve(answered({ version }));
        if (path.endsWith('/printers')) return Promise.resolve(answered([]));

        return Promise.resolve(answered({ accessibleJobs: [], totalJobs: 0 }));
      });
    };

    it('says so, naming both', async () => {
      answeringAsRelease('1.3.0');

      render(<App pageVersion="1.2.3" />);

      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('This page is 1.2.3 and the shop is 1.3.0'));
    });

    it('says nothing of the kind when they match', async () => {
      answeringAsRelease('1.2.3');

      render(<App pageVersion="1.2.3" />);

      await waitFor(() => expect(asked('GET', '/version')).toBeDefined());
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});
