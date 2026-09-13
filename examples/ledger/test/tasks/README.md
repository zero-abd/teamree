# test/tasks

One file per task in `../../TASKS.md`. **These fail on purpose.** Each is the
target of a task nobody has done yet, and it goes green when that task is
finished — that is what "done" means here, rather than somebody's opinion of
whether the code looks right.

They are outside `npm test` on purpose too. `npm test` is the suite that says
whether you broke the project, and it must be green before you start and green
when you stop; a suite that is red for reasons that are not your fault teaches
everybody to ignore it. Three people take three tasks, and no one of them should
be reading the other two's failures.

```sh
npm test               # 39 tests, all passing, all of them somebody else's work
npm run test:task2     # your task's target: red now, green when you are done
```

A target test is the requirement, not a suggestion: if you think it asserts the
wrong thing, that is a question for the team, not an edit. Where a task has a
decision in it that is not the implementer's to make, the target test says
nothing about that decision — look for "Ask first" in `TASKS.md`.
