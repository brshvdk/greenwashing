# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue: on GitHub, open this repository's Security tab, then Advisories, then "Report a vulnerability".

Say what you found, how to reproduce it and what it lets someone do. This is a one-person project: I aim to reply within a week and to tell you what I plan to do about it and when.

## What counts

greenwashing runs on your machine: its hooks and its command run its own scripts, git (which follows your repository's own git settings) and your own test command. A security problem is anything that makes it do more than that, for example:

- sending data off your machine, or reading files it has no reason to read;
- running code other than its own scripts, git and your test command;
- letting another user of the machine read or change what it keeps on disk.

An agent that gets past the gate, for example by killing the hook or editing its state file, is a known limit, not a vulnerability: the gate is a seatbelt, not a jail. Those limits are listed in docs/limitations.md, and new ones are welcome as regular issues.

## Supported versions

Only the latest commit on main: the plugin has no releases.
