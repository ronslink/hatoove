COORD-VERIFY: J7 verified by execution — the journey counter moved 4/7/0 -> 5/6/0, and the worker really is a child process

The WORKER-WIRE-01 branch claims its Step 2 turns J7 from PENDING into a pass. I re-executed it
myself on a FRESH disposable database rather than accepting the branch's account of itself, because
the whole point of this slice is that a claim about composition is worthless without a run.

THE COUNTER MOVED. node tools/journey-api-check.mjs on this head:

    5 passed, 6 pending, 0 failed        (was 4 passed, 7 pending, 0 failed)

AND J7'S OWN DETAIL LINE IS THE EVIDENCE, not the word PASS:

    J7  worker produces feedback in the chosen language (recoverable, one debit)
        child process worker connected as hatoove_worker (application_name hatoove:worker);
        submit reserved 1 -> 0; job succeeded; assessment=stub model_version=stub-grader-v1;
        used 0->1; exactly one debit

Four things in that line are each independently the property this product needs:
  * CHILD PROCESS, not an in-process call - which is why the slice would have been worthless if it
    had taken the shortcut the dispatch warned about;
  * hatoove_worker - the RESTRICTED role, so the runner is not a privileged pool;
  * reserved 1 -> 0 and used 0 -> 1 - the reservation is released and exactly ONE debit occurs;
  * model_version=stub-grader-v1 - so the leg proves the PIPELINE and made no provider call.

So "write, submit, leave while pending, come back and read your feedback" is now a proven path
rather than a claimed one. The submission/job/assessment/debit machinery the checks used to be the
only caller of now has a real composition behind it.

THE EXISTING COUNTERS DID NOT MOVE - the failure mode a composition change is most likely to cause:
    tools/worker-runner-check.mjs   10 passed, 0 failed   (unchanged)
    tools/deletion-check.mjs        18 passed, 0 failed   (unchanged)
    tools/table-class-check.mjs     OK: every table is classified and every class rule holds
    tools/postgres-provision-check  5 passed, 0 failed    (unchanged)

WHAT THIS DOES NOT PROVE, stated because the slice's own record must say it too: one machine, one
database, one worker at a time in these legs. It is not evidence about a real deployment's supervisor,
about multiple instances, or about a worker that dies with its lease held in production. The branch's
LIMITS section is where that belongs, and the coordinator's verification is narrower than it looks.

Base: 2b0295e
