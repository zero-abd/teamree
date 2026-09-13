// Time is a dependency here rather than an ambient fact, because every limit the
// relay enforces is a deadline, and a test that proves a deadline fires by
// sleeping through it is both slow and a coin toss.
//
// Reading the time is all core asks for. It never schedules anything: deadlines
// are checked when the host calls `sweep`, and how often that happens is the
// host's business — an interval timer under Node, an alarm inside a Durable
// Object. Core owning a scheduler is what would have made it unportable.

export type Clock = { now: () => number }

export const systemClock: Clock = { now: () => Date.now() }
